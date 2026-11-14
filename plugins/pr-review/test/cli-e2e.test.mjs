import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { EXIT_CODES, BUDGETS, REVIEW_MARKER, SCHEMA_VERSION, normalizeRepoRelPath, validateReviewFinding } from '../src/contracts.mjs'
import { evaluateIntentAlignment } from '../src/intent.mjs'
import { publishRepoPullRequest } from '../src/git-api-pr.mjs'
import { runCli } from '../src/cli.mjs'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = dirname(TEST_DIR)
const REPO_ROOT = dirname(dirname(PLUGIN_ROOT))
const SAMPLE_FIXTURE = join(TEST_DIR, 'fixtures', 'sample-pr')

function invokeCli(argv, extraOptions = {}) {
  let stdout = ''
  let stderr = ''
  return runCli(argv, {
    stdout: { write: (chunk) => { stdout += String(chunk) } },
    stderr: { write: (chunk) => { stderr += String(chunk) } },
    env: extraOptions.env ?? {},
    fetchImpl: extraOptions.fetchImpl
  }).then((code) => ({
    code,
    stdout,
    stderr,
    json: stdout.trim().startsWith('{') ? JSON.parse(stdout) : null,
    errJson: stderr.trim().startsWith('{') ? JSON.parse(stderr) : null
  }))
}

test('CLI selftest runs all contract and pipeline invariants green', async () => {
  const res = await invokeCli(['selftest', '--json'])
  assert.equal(res.code, EXIT_CODES.OK)
  assert.equal(res.json.data.ok, true)
  assert.equal(res.json.data.core_lenses, 13)
  assert.equal(res.json.data.conditional_lenses, 4)
})

test('CLI lenses selects 13 core lenses plus triggered conditional lenses', async () => {
  const res = await invokeCli([
    'lenses',
    '--files',
    'src/cache-store.mjs,packs/hivemind/opencode/commands/demo.md,plugins/x/locale/en.json',
    '--json'
  ])
  assert.equal(res.code, EXIT_CODES.OK)
  const selected = new Set(res.json.data.selected_lenses)
  assert.equal(selected.size, 15)
  assert.ok(selected.has('llm-prompt-safety'))
  assert.ok(selected.has('i18n-localization'))
  assert.ok(!selected.has('accessibility-ux'))
})

test('End-to-end swarm CLI pipeline: ingest -> prompt -> validate-report -> synthesize -> render -> publish', async () => {
  const workTmp = mkdtempSync(join(tmpdir(), 'hivemind-pr-review-e2e-'))
  try {
    const runDir = join(workTmp, 'run')
    const prRefFile = join(workTmp, 'pr-ref.txt')
    writeFileSync(prRefFile, 'https://github.com/acme/plugin-library/pull/42\n', 'utf8')

    // 1. Ingest from fixture via --pr-file (zero shell interpolation)
    const ingestRes = await invokeCli([
      'ingest',
      '--pr-file', prRefFile,
      '--from-fixture', SAMPLE_FIXTURE,
      '--run-dir', runDir,
      '--max-parallel', '6',
      '--json'
    ])
    assert.equal(ingestRes.code, EXIT_CODES.OK)
    assert.equal(ingestRes.json.data.stated_intent.has_problem_statement, true)
    assert.equal(ingestRes.json.data.stated_intent.has_solution, true)
    assert.ok(ingestRes.json.data.selected_lenses.some((l) => l.id === 'llm-prompt-safety'))
    assert.ok(existsSync(join(runDir, 'packet.json')))
    assert.ok(existsSync(join(runDir, 'slices', 'security.json')))

    const headSha = ingestRes.json.data.pr_meta.head_sha

    // 2. Render worker prompt and verify PR title/body AND untrusted PR injection defanging
    const promptRes = await invokeCli(['prompt', '--run-dir', runDir, '--lens', 'intent-alignment'])
    assert.equal(promptRes.code, EXIT_CODES.OK)
    assert.ok(promptRes.stdout.includes('Harden cache refresh and path handling'))
    assert.ok(promptRes.stdout.includes('Serialize refresh operations through a per-key queue'))
    assert.ok(promptRes.stdout.includes('[DEFANGED_QUARANTINE_TAG]'))
    assert.ok(!promptRes.stdout.includes('<!-- SYSTEM:'))
    assert.ok(promptRes.stdout.includes('intent_alignment'))

    // 3. Write specialist worker reports (corroborating finding + unanchorable BLOCKER + hallucinated file)
    const intentReport = {
      schema_version: SCHEMA_VERSION,
      lens_id: 'intent-alignment',
      head_sha: headSha,
      summary: 'PR adds unmentioned telemetry module and leaves cache refresh unserialized.',
      findings: [
        {
          severity: 'MEDIUM',
          confidence: 'HIGH',
          path: 'src/telemetry-secret.mjs',
          line_start: 4,
          line_end: 5,
          side: 'RIGHT',
          title: 'Unstated telemetry writer added outside PR Problem/Solution scope',
          body: 'src/telemetry-secret.mjs is not mentioned in Problem Statement or Solution.',
          suggestion: '',
          evidence_quote: 'export function recordTelemetry(event)'
        }
      ],
      intent_alignment: {
        verdict: 'PARTIAL',
        has_problem_statement: true,
        has_solution: true,
        claim_mappings: [
          {
            claim_id: 'c1',
            claim_text: 'Validate cache keys before joining onto cache root',
            matched_files: ['src/cache-store.mjs'],
            status: 'unfulfilled'
          }
        ],
        scope_creep_files: ['src/telemetry-secret.mjs'],
        unfulfilled_claims: ['Validate cache keys before joining onto cache root'],
        summary: 'Path validation claim is unfulfilled and telemetry-secret.mjs is scope creep.'
      }
    }

    const securityReport = {
      schema_version: SCHEMA_VERSION,
      lens_id: 'security',
      head_sha: headSha,
      summary: 'Path traversal in cachePath and raw $ARGUMENTS in demo command.',
      findings: [
        {
          severity: 'HIGH',
          confidence: 'MEDIUM',
          path: 'src/cache-store.mjs',
          line_start: 13,
          line_end: 15,
          side: 'RIGHT',
          title: 'Unvalidated cache key allows path traversal outside root',
          body: 'join(root, key) allows ../ segments to escape root.',
          suggestion: '  const safeKey = key.replace(/[^A-Za-z0-9._-]/g, "_")\n  return join(root, safeKey)',
          evidence_quote: 'return join(root, key)'
        },
        {
          severity: 'BLOCKER',
          confidence: 'HIGH',
          path: 'src/cache-store.mjs',
          line_start: 999,
          line_end: 999,
          side: 'RIGHT',
          title: 'Hallucinated anchor line outside diff hunk',
          body: 'Line 999 is not in the diff hunk and must be demoted.',
          suggestion: '',
          evidence_quote: 'return join(root, key)'
        },
        {
          severity: 'HIGH',
          confidence: 'HIGH',
          path: 'src/nonexistent-hallucinated.mjs',
          line_start: 1,
          line_end: 1,
          side: 'RIGHT',
          title: 'Hallucinated file not in PR',
          body: 'Must be dropped during evidence verification.',
          suggestion: '',
          evidence_quote: 'const nope = true'
        }
      ]
    }

    const raceReport = {
      schema_version: SCHEMA_VERSION,
      lens_id: 'data-race-conditions',
      head_sha: headSha,
      summary: 'Corroborates unsafe cache key path join and async race.',
      findings: [
        {
          severity: 'HIGH',
          confidence: 'MEDIUM',
          path: 'src/cache-store.mjs',
          line_start: 13,
          line_end: 15,
          side: 'RIGHT',
          title: 'Unvalidated cache key path join races across keys',
          body: 'join(root, key) is unvalidated and shared across concurrent writes.',
          suggestion: '',
          evidence_quote: 'return join(root, key)'
        }
      ]
    }

    writeFileSync(join(runDir, 'reports', 'intent-alignment.json'), JSON.stringify(intentReport, null, 2))
    writeFileSync(join(runDir, 'reports', 'security.json'), JSON.stringify(securityReport, null, 2))
    writeFileSync(join(runDir, 'reports', 'data-race-conditions.json'), JSON.stringify(raceReport, null, 2))

    // 4. Validate report
    const valRes = await invokeCli(['validate-report', '--run-dir', runDir, '--lens', 'security', '--json'])
    assert.equal(valRes.code, EXIT_CODES.OK)
    assert.equal(valRes.json.data.verified_anchorable, 1)
    assert.equal(valRes.json.data.demoted, 1)
    assert.equal(valRes.json.data.dropped_hallucinated, 1)

    // 5. Synthesize
    const synRes = await invokeCli(['synthesize', '--run-dir', runDir, '--json'])
    assert.equal(synRes.code, EXIT_CODES.OK)
    const payload = synRes.json.data
    assert.equal(payload.verdict, 'REQUEST_CHANGES')
    assert.equal(payload.stats.dropped_hallucinated_path, 1)
    assert.equal(payload.stats.deduplicated_merged, 1)

    const corroborated = payload.inline_comments.find((c) => c.path === 'src/cache-store.mjs')
    assert.ok(corroborated)
    assert.equal(corroborated.confidence, 'HIGH')
    assert.deepEqual(corroborated.corroborating_lenses, ['data-race-conditions', 'security'])

    // Unanchorable BLOCKER was demoted to MEDIUM in summary_findings
    assert.equal(payload.summary_findings.length, 1)
    assert.equal(payload.summary_findings[0].severity, 'MEDIUM')

    // 6. Render Markdown
    const renderRes = await invokeCli(['render', '--run-dir', runDir])
    assert.equal(renderRes.code, EXIT_CODES.OK)
    assert.ok(renderRes.stdout.includes(REVIEW_MARKER))
    assert.ok(renderRes.stdout.includes('src/telemetry-secret.mjs'))

    // 7. Publish dry-run succeeds; --post without --confirm refuses (exit 2)
    const dryPub = await invokeCli(['publish', '--run-dir', runDir, '--json'])
    assert.equal(dryPub.code, EXIT_CODES.OK)
    assert.equal(dryPub.json.data.posted, false)

    const unconfirmedPub = await invokeCli(['publish', '--run-dir', runDir, '--post', '--json'])
    assert.equal(unconfirmedPub.code, EXIT_CODES.VALIDATION)
    assert.equal(unconfirmedPub.errJson.error.code, 'refused')

    // 8. Publish --post --confirm against local mock GitHub HTTP server + duplicate guard
    const postedReviews = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        if (req.method === 'GET' && req.url === '/repos/acme/plugin-library/pulls/42') {
          res.writeHead(200)
          res.end(JSON.stringify({ head: { sha: headSha } }))
          return
        }
        if (req.method === 'GET' && req.url?.startsWith('/repos/acme/plugin-library/pulls/42/reviews')) {
          res.writeHead(200)
          res.end(JSON.stringify(postedReviews))
          return
        }
        if (req.method === 'POST' && req.url === '/repos/acme/plugin-library/pulls/42/reviews') {
          const parsed = JSON.parse(body)
          const created = {
            id: 9001,
            body: parsed.body,
            event: parsed.event,
            html_url: 'https://github.com/acme/plugin-library/pull/42#pullrequestreview-9001'
          }
          postedReviews.push(created)
          res.writeHead(200)
          res.end(JSON.stringify(created))
          return
        }
        res.writeHead(404)
        res.end(JSON.stringify({ message: 'Not Found' }))
      })
    })

    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    try {
      const addr = server.address()
      const apiBase = `http://127.0.0.1:${addr.port}`

      const livePub = await invokeCli(
        ['publish', '--run-dir', runDir, '--post', '--confirm', '--api-base', apiBase, '--json'],
        { env: { GITHUB_TOKEN: 'test-ephemeral-token' } }
      )
      assert.equal(livePub.code, EXIT_CODES.OK)
      assert.equal(livePub.json.data.posted, true)
      assert.equal(livePub.json.data.review_url, 'https://github.com/acme/plugin-library/pull/42#pullrequestreview-9001')

      // Second post without --force is refused by REVIEW_MARKER idempotency (exit 3)
      const dupPub = await invokeCli(
        ['publish', '--run-dir', runDir, '--post', '--confirm', '--api-base', apiBase, '--json'],
        { env: { GITHUB_TOKEN: 'test-ephemeral-token' } }
      )
      assert.equal(dupPub.code, EXIT_CODES.NOT_FOUND_OR_REFUSED)
      assert.equal(dupPub.errJson.error.code, 'duplicate_review')
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose))
    }
  } finally {
    rmSync(workTmp, { recursive: true, force: true })
  }
})

test('CLI validate-report rejects a report whose lens_id does not match --lens', async () => {
  const workTmp = mkdtempSync(join(tmpdir(), 'hivemind-pr-review-lens-'))
  try {
    writeFileSync(join(workTmp, 'mismatched.json'), JSON.stringify({
      schema_version: SCHEMA_VERSION,
      lens_id: 'intent-alignment',
      head_sha: 'a'.repeat(40),
      summary: 'This report belongs to intent-alignment, not security.',
      findings: []
    }, null, 2), 'utf8')

    const res = await invokeCli([
      'validate-report',
      join(workTmp, 'mismatched.json'),
      '--lens', 'security',
      '--json'
    ])
    assert.equal(res.code, EXIT_CODES.VALIDATION)
    assert.equal(res.errJson.error.code, 'invalid_input')
    assert.match(res.errJson.error.message, /does not match --lens security/)
  } finally {
    rmSync(workTmp, { recursive: true, force: true })
  }
})

test('CLI publish run-dir rejects a payload head_sha that differs from packet.json before any network', async () => {
  const workTmp = mkdtempSync(join(tmpdir(), 'hivemind-pr-review-head-'))
  try {
    const packetHead = '1'.repeat(40)
    const payloadHead = '2'.repeat(40)
    writeFileSync(join(workTmp, 'packet.json'), JSON.stringify({
      schema_version: SCHEMA_VERSION,
      pr_ref: {
        owner: 'acme',
        repo: 'plugin-library',
        number: 42,
        canonical_url: 'https://github.com/acme/plugin-library/pull/42',
        short_ref: 'acme/plugin-library#42'
      },
      pr_meta: { number: 42, head_sha: packetHead, base_sha: '3'.repeat(40) },
      files: [],
      hunks: [],
      selected_lenses: [],
      waves: []
    }, null, 2), 'utf8')
    writeFileSync(join(workTmp, 'synthesis.json'), JSON.stringify({
      schema_version: SCHEMA_VERSION,
      pr_ref: {
        canonical_url: 'https://github.com/acme/plugin-library/pull/42',
        short_ref: 'acme/plugin-library#42',
        owner: 'acme',
        repo: 'plugin-library',
        number: 42
      },
      head_sha: payloadHead,
      verdict: 'COMMENT',
      intent: {
        verdict: 'ALIGNED',
        has_problem_statement: true,
        has_solution: true,
        claim_mappings: [],
        scope_creep_files: [],
        unfulfilled_claims: [],
        summary: 'Valid payload except for a stale head SHA.'
      },
      inline_comments: [],
      summary_findings: [],
      lens_coverage: [],
      stats: { subagent_reports: 0, selected_lenses: 0 }
    }, null, 2), 'utf8')

    let networkCalls = 0
    const res = await invokeCli(
      ['publish', '--run-dir', workTmp, '--post', '--confirm', '--json'],
      {
        env: { GITHUB_TOKEN: 'test-ephemeral-token' },
        fetchImpl: async () => {
          networkCalls += 1
          throw new Error('network should not be called')
        }
      }
    )
    assert.equal(res.code, EXIT_CODES.STALE_HEAD)
    assert.equal(res.errJson.error.code, 'stale_head_sha')
    assert.equal(networkCalls, 0)
  } finally {
    rmSync(workTmp, { recursive: true, force: true })
  }
})

test('Hivemind pack wiring is consistent across commands, agents, skills, switchers, and all 5 profiles', () => {
  const packRoot = join(REPO_ROOT, 'packs', 'hivemind')
  const cmdText = readFileSync(join(packRoot, 'opencode', 'commands', 'pr-review.md'), 'utf8')
  const agentText = readFileSync(join(packRoot, 'opencode', 'agents', 'pr-reviewer.md'), 'utf8')
  const skillText = readFileSync(join(packRoot, 'opencode', 'skills', 'pr-review', 'SKILL.md'), 'utf8')
  const switchPs1 = readFileSync(join(packRoot, 'hive-switch.ps1'), 'utf8')
  const switchSh = readFileSync(join(packRoot, 'bin', 'hive-switch'), 'utf8')

  assert.match(cmdText, /^---\r?\n[\s\S]*agent:\s*hivemind-architect[\s\S]*---/)
  assert.match(agentText, /^---\r?\n[\s\S]*mode:\s*subagent[\s\S]*permissions:[\s\S]*action:\s*["']?\*["']?[\s\S]*resource:\s*["']?\*["']?[\s\S]*effect:\s*deny[\s\S]*---/)
  assert.doesNotMatch(agentText.split(/^---\r?$/m)[1], /^permission:|^temperature:/m)
  assert.match(skillText, /^---\r?\n[\s\S]*name:\s*pr-review[\s\S]*---/)
  assert.ok(switchPs1.includes('"pr-reviewer"'))
  assert.ok(switchSh.includes('"pr-reviewer"'))

  const profilesDir = join(packRoot, 'profiles')
  const profileFiles = readdirSync(profilesDir).filter((f) => f.endsWith('.json'))
  assert.equal(profileFiles.length, 5)
  for (const file of profileFiles) {
    const data = JSON.parse(readFileSync(join(profilesDir, file), 'utf8'))
    assert.ok(typeof data.agent_models['pr-reviewer'] === 'string' && data.agent_models['pr-reviewer'].includes('/'))
  }
})

test('Security regression guards: monotonic intent pessimism, finding path canonicalization, and safe tree pruning', async () => {
  // 1. Finding path with leading slash canonicalizes while drive-letter diff path rejects
  const normalizedFinding = validateReviewFinding({
    lens_id: 'security',
    severity: 'LOW',
    confidence: 'HIGH',
    path: '/src/cache-store.mjs',
    line_start: 1,
    line_end: 1,
    side: 'RIGHT',
    title: 'Leading slash canonicalization',
    body: 'Normalized cleanly.',
    evidence_quote: 'import { join } from "node:path"'
  })
  assert.equal(normalizedFinding.path, 'src/cache-store.mjs')
  assert.throws(() => normalizeRepoRelPath('D:/outside/file.mjs'))

  // 2. Monotonic pessimism: LLM override cannot mark an unfulfilled claim as covered or force ungrounded MISALIGNED
  const packet = {
    schema_version: 1,
    pr_ref: { owner: 'acme', repo: 'demo', number: 1, canonical_url: 'https://github.com/acme/demo/pull/1', short_ref: 'acme/demo#1' },
    pr_meta: { number: 1, head_sha: '1111111111111111111111111111111111111111', base_sha: '2222222222222222222222222222222222222222' },
    stated_intent: {
      title: 'Implement rate limiter middleware',
      body: '## Problem Statement\nMissing rate limiter.\n## Solution\nAdd rate limiter in src/rate-limit.mjs.',
      has_problem_statement: true,
      has_solution: true,
      claims: [{ id: 'c1', source: 'solution', text: 'Add rate limiter in src/rate-limit.mjs' }]
    },
    files: [{ path: 'src/unrelated.mjs', old_path: 'src/unrelated.mjs', status: 'modified', is_binary: false, additions: 1, deletions: 0, hunk_ids: ['h1'], anchorable_new_lines: [1], anchorable_old_lines: [], sha256: 'abc' }],
    hunks: [{ id: 'h1', path: 'src/unrelated.mjs', header: '@@ -0,0 +1,1 @@', old_start: 0, old_lines: 0, new_start: 1, new_lines: 1, raw_patch: '+export const x = 1', lines: [{ type: 'add', old_line: null, new_line: 1, content: 'export const x = 1' }] }],
    selected_lenses: [{ id: 'intent-alignment', reason: 'core_always_on' }],
    waves: [['intent-alignment']]
  }
  const attemptUpgrade = evaluateIntentAlignment(packet, {
    verdict: 'ALIGNED',
    claim_mappings: [{ claim_id: 'c1', claim: 'Add rate limiter in src/rate-limit.mjs', status: 'covered', matched_files: ['src/unrelated.mjs'] }]
  })
  assert.notEqual(attemptUpgrade.verdict, 'ALIGNED')
  assert.equal(attemptUpgrade.claim_mappings[0].status, 'unfulfilled')
  assert.ok(attemptUpgrade.scope_creep_files.includes('src/unrelated.mjs'))

  // Also ensure an override cannot suppress deterministic scope creep when primary claim IS covered
  const creepPacket = {
    ...packet,
    files: [
      { path: 'src/rate-limit.mjs', old_path: 'src/rate-limit.mjs', status: 'modified', is_binary: false, additions: 1, deletions: 0, hunk_ids: ['h0'], anchorable_new_lines: [1], anchorable_old_lines: [], sha256: 'def' },
      ...packet.files
    ],
    hunks: [
      { id: 'h0', path: 'src/rate-limit.mjs', header: '@@ -0,0 +1,1 @@', old_start: 0, old_lines: 0, new_start: 1, new_lines: 1, raw_patch: '+export const rateLimit = true', lines: [{ type: 'add', old_line: null, new_line: 1, content: 'export const rateLimit = true' }] },
      ...packet.hunks
    ]
  }
  const creepSuppressionAttempt = evaluateIntentAlignment(creepPacket, {
    verdict: 'ALIGNED',
    claim_mappings: [{ claim: 'Secretly also touch unrelated', status: 'covered', matched_files: ['src/unrelated.mjs'] }]
  })
  assert.equal(creepSuppressionAttempt.verdict, 'PARTIAL')
  assert.ok(creepSuppressionAttempt.scope_creep_files.includes('src/unrelated.mjs'))

  // 3. Safe tree pruning: zero-overlap allowPrune:true refuses mass wipe
  const tmpRepo = mkdtempSync(join(tmpdir(), 'pr-prune-guard-'))
  try {
    writeFileSync(join(tmpRepo, 'subfile.mjs'), 'export const s = 1\n', 'utf8')
    await assert.rejects(
      () => publishRepoPullRequest({
        workDir: tmpRepo,
        owner: 'acme',
        repo: 'demo',
        title: 'Test',
        body: '## Problem Statement\nP\n## Solution\nS\n',
        token: 'tok',
        direct: true,
        allowPrune: true,
        timeoutMs: 5000,
        fetchImpl: async (url) => ({
          ok: true,
          status: 200,
          text: async () => {
            if (url.includes('/pulls?')) return '[]'
            if (url.includes('/git/ref/')) return JSON.stringify({ object: { sha: 'c1' } })
            if (url.includes('/git/commits/')) return JSON.stringify({ tree: { sha: 't1' } })
            if (url.includes('/git/trees/')) return JSON.stringify({ tree: [{ path: 'README.md', type: 'blob', sha: 'r1' }] })
            return '{}'
          }
        })
      }),
      (err) => err.code === 'refused'
    )
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true })
  }
})

function promptLineCount(prompt) {
  const lines = String(prompt).split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

function assertCompleteBoundedPrompt(prompt, { lensId, headSha }) {
  const bytes = Buffer.byteLength(prompt, 'utf8')
  assert.ok(
    bytes <= BUDGETS.MAX_PROMPT_BYTES,
    `${lensId} prompt is ${bytes} UTF-8 bytes, over MAX_PROMPT_BYTES (${BUDGETS.MAX_PROMPT_BYTES})`
  )
  const lines = promptLineCount(prompt)
  assert.ok(
    lines <= BUDGETS.MAX_PROMPT_LINES,
    `${lensId} prompt is ${lines} lines, over MAX_PROMPT_LINES (${BUDGETS.MAX_PROMPT_LINES})`
  )

  // The trusted scaffolding and JSON output contract must survive intact; a
  // tool that substrings a finished prompt would cut these off.
  assert.match(prompt, /^# PR Review Worker/)
  assert.ok(prompt.includes(`"lens_id": "${lensId}"`), `missing lens_id in ${lensId} prompt`)
  assert.ok(prompt.includes(`"head_sha": "${headSha}"`), `missing head_sha in ${lensId} prompt`)
  assert.ok(prompt.includes('Return ONLY one JSON object'), `missing output contract in ${lensId} prompt`)
  assert.ok(prompt.includes('"schema_version": 1'), `missing schema_version in ${lensId} prompt`)
  assert.ok(prompt.includes('"findings": ['), `missing findings schema in ${lensId} prompt`)
  for (const field of [
    'severity', 'confidence', 'path', 'line_start', 'line_end', 'side',
    'title', 'body', 'suggestion', 'evidence_quote'
  ]) {
    assert.ok(prompt.includes(`"${field}"`), `missing finding schema field "${field}" in ${lensId} prompt`)
  }
  assert.match(prompt, /- At most \d+ findings\./, `missing findings rule tail in ${lensId} prompt`)
  assert.match(
    prompt,
    /\[(?:NEW:\d+|OLD:\d+|OLD:\d+ NEW:\d+)\]/,
    `retained diff lines must keep explicit coordinates in ${lensId} prompt`
  )

  // Fences must stay balanced even when passive data is clipped.
  const opens = (prompt.match(/<untrusted_pr_data\b/g) ?? []).length
  const closes = (prompt.match(/<\/untrusted_pr_data>/g) ?? []).length
  assert.ok(opens > 0, `${lensId} prompt has no quarantine fences`)
  assert.equal(opens, closes, `${lensId} prompt has unbalanced quarantine fences`)
}

function inflateStoredSlice(slicePath) {
  const slice = JSON.parse(readFileSync(slicePath, 'utf8'))
  for (let hunkIndex = 0; hunkIndex < 120; hunkIndex += 1) {
    const start = 1000 + hunkIndex * 100
    const lines = []
    for (let lineIndex = 0; lineIndex < 90; lineIndex += 1) {
      lines.push({
        type: 'context',
        old_line: start + lineIndex,
        new_line: start + lineIndex,
        content: `generated context ${hunkIndex}-${lineIndex} ${'x'.repeat(120)}`
      })
    }
    slice.hunks.push({
      id: `synthetic-${hunkIndex}`,
      path: 'src/cache-store.mjs',
      file_path: 'src/cache-store.mjs',
      header: `@@ -${start},90 +${start},90 @@`,
      old_start: start,
      old_lines: 90,
      new_start: start,
      new_lines: 90,
      raw_patch: '',
      lines
    })
  }
  // Stale/unbounded stored slices may even claim they are complete; the prompt
  // renderer must still re-bound and disclose the real coverage.
  slice.truncated = false
  const serialized = JSON.stringify(slice, null, 2)
  assert.ok(
    Buffer.byteLength(serialized, 'utf8') > BUDGETS.MAX_SLICE_BYTES * 10,
    'inflated stored slice must clearly exceed MAX_SLICE_BYTES'
  )
  writeFileSync(slicePath, serialized, 'utf8')
}

test('CLI prompt re-bounds a legacy oversized stored slice deterministically and keeps the complete contract', async () => {
  const workTmp = mkdtempSync(join(tmpdir(), 'hivemind-pr-review-budget-'))
  try {
    const runDir = join(workTmp, 'run')
    const prRefFile = join(workTmp, 'pr-ref.txt')
    writeFileSync(prRefFile, 'https://github.com/acme/plugin-library/pull/42\n', 'utf8')

    const ingestRes = await invokeCli([
      'ingest',
      '--pr-file', prRefFile,
      '--from-fixture', SAMPLE_FIXTURE,
      '--run-dir', runDir,
      '--json'
    ])
    assert.equal(ingestRes.code, EXIT_CODES.OK)
    const packet = JSON.parse(readFileSync(join(runDir, 'packet.json'), 'utf8'))

    for (const lensId of ['security', 'intent-alignment']) {
      inflateStoredSlice(join(runDir, 'slices', `${lensId}.json`))

      const first = await invokeCli(['prompt', '--run-dir', runDir, '--lens', lensId])
      assert.equal(first.code, EXIT_CODES.OK)
      const second = await invokeCli(['prompt', '--run-dir', runDir, '--lens', lensId])
      assert.equal(second.code, EXIT_CODES.OK)
      assert.equal(second.stdout, first.stdout, `${lensId} prompt must be byte-for-byte deterministic`)

      assertCompleteBoundedPrompt(first.stdout, { lensId, headSha: packet.pr_meta.head_sha })
      assert.match(
        first.stdout,
        /truncat\w*:\s*yes|limited (?:diff )?coverage|coverage[^\n]*limited|omitted[^\n]*(?:diff|hunk|line)/i,
        `${lensId} clipped prompt must disclose limited diff coverage`
      )

      if (lensId === 'intent-alignment') {
        assert.ok(first.stdout.includes('"intent_alignment"'), 'intent prompt must include intent_alignment body')
        for (const field of [
          'verdict', 'has_problem_statement', 'has_solution', 'claim_mappings',
          'scope_creep_files', 'unfulfilled_claims', 'summary'
        ]) {
          assert.ok(first.stdout.includes(`"${field}"`), `intent prompt missing intent field "${field}"`)
        }
      }
    }
  } finally {
    rmSync(workTmp, { recursive: true, force: true })
  }
})

test('CLI prompt has no --budget flag and --max-lines is the real slice line override', async () => {
  const workTmp = mkdtempSync(join(tmpdir(), 'hivemind-pr-review-flags-'))
  try {
    const runDir = join(workTmp, 'run')
    const prRefFile = join(workTmp, 'pr-ref.txt')
    writeFileSync(prRefFile, 'https://github.com/acme/plugin-library/pull/42\n', 'utf8')

    const ingestRes = await invokeCli([
      'ingest',
      '--pr-file', prRefFile,
      '--from-fixture', SAMPLE_FIXTURE,
      '--run-dir', runDir,
      '--json'
    ])
    assert.equal(ingestRes.code, EXIT_CODES.OK)

    const budgetRes = await invokeCli([
      'prompt', '--run-dir', runDir, '--lens', 'security', '--budget', '1000'
    ])
    assert.equal(budgetRes.code, EXIT_CODES.VALIDATION)
    assert.equal(budgetRes.errJson.error.code, 'invalid_input')
    assert.match(budgetRes.errJson.error.message, /Unknown option: --budget/)

    const sliceRes = await invokeCli([
      'slice', '--run-dir', runDir, '--lens', 'security', '--max-lines', '400', '--json'
    ])
    assert.equal(sliceRes.code, EXIT_CODES.OK)
    assert.ok(sliceRes.json.data.line_count <= 400)
  } finally {
    rmSync(workTmp, { recursive: true, force: true })
  }
})
