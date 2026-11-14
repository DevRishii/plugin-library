import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ERROR_CODES, EXIT_CODES, REVIEW_MARKER } from '../src/contracts.mjs'
import {
  buildGitHubReviewApiBody,
  renderInlineCommentBody,
  renderReviewMarkdown
} from '../src/render.mjs'
import { publishPRReview } from '../src/publish.mjs'
import { publishRepoPullRequest } from '../src/git-api-pr.mjs'
import { synthesizeReview } from '../src/synthesize.mjs'

const HEAD_SHA = 'a'.repeat(40)
const LIVE_OTHER_SHA = 'b'.repeat(40)
const GOOD_BODY = '## Problem Statement\n\nAdd a PR review swarm.\n\n## Solution\n\nPublish reviews through GitHub.'

function makePayload(overrides = {}) {
  return {
    schema_version: 1,
    pr_ref: {
      canonical_url: 'https://github.com/acme/widgets/pull/7',
      short_ref: 'acme/widgets#7',
      owner: 'acme',
      repo: 'widgets',
      number: 7
    },
    head_sha: HEAD_SHA,
    verdict: 'REQUEST_CHANGES',
    intent: {
      verdict: 'PARTIAL',
      has_problem_statement: true,
      has_solution: true,
      claim_mappings: [],
      scope_creep_files: ['src/unrelated.mjs'],
      unfulfilled_claims: ['Promised retry logic is missing'],
      summary: 'The PR implements the core path but leaves retry behavior unimplemented.'
    },
    inline_comments: [
      {
        lens_id: 'security',
        severity: 'HIGH',
        title: 'Unvalidated path input',
        body: 'The path is joined without normalization.',
        suggestion: 'const safe = path.normalize(input)',
        path: 'src/runner.mjs',
        line: 12,
        line_end: 12,
        side: 'RIGHT'
      }
    ],
    summary_findings: [
      {
        lens_id: 'testing-verification',
        severity: 'MEDIUM',
        title: 'Missing negative-path test',
        body: 'No test covers the rejected input branch.'
      }
    ],
    lens_coverage: [
      { lens_id: 'security', status: 'completed', reviewed: true, report_count: 1, finding_count: 1 },
      { lens_id: 'testing-verification', status: 'completed', reviewed: true, report_count: 1, finding_count: 1 }
    ],
    stats: {
      subagent_reports: 2,
      selected_lenses: 2,
      raw_findings: 2,
      findings_total: 2,
      findings_reported: 2,
      verified_inline: 1,
      demoted_to_summary: 1,
      deduplicated_merged: 0,
      findings_deduped: 0,
      dropped_hallucinated_path: 0
    },
    ...overrides
  }
}

function makeCompleteApprovePayload(overrides = {}) {
  return makePayload({
    verdict: 'APPROVE',
    intent: {
      verdict: 'ALIGNED',
      has_problem_statement: true,
      has_solution: true,
      claim_mappings: [
        {
          claim_id: 'c1',
          claim: 'Publish reviews through GitHub.',
          status: 'covered',
          matched_files: ['src/runner.mjs']
        }
      ],
      scope_creep_files: [],
      unfulfilled_claims: [],
      summary: 'The diff fulfills the stated Problem Statement and Solution.'
    },
    inline_comments: [],
    summary_findings: [],
    lens_coverage: [
      { lens_id: 'intent-alignment', status: 'completed', reviewed: true, report_count: 1, finding_count: 0 },
      { lens_id: 'security', status: 'completed', reviewed: true, report_count: 1, finding_count: 0 }
    ],
    stats: {
      subagent_reports: 2,
      selected_lenses: 2,
      raw_findings: 0,
      findings_total: 0,
      findings_reported: 0,
      verified_inline: 0,
      demoted_to_summary: 0,
      deduplicated_merged: 0,
      findings_deduped: 0,
      dropped_hallucinated_path: 0
    },
    ...overrides
  })
}

function makeSevereFinding(severity, overrides = {}) {
  return {
    lens_id: 'security',
    severity,
    confidence: 'HIGH',
    title: `${severity} legacy finding`,
    body: 'A legacy APPROVE artifact retained this finding.',
    path: 'src/runner.mjs',
    line: 12,
    line_end: 12,
    side: 'RIGHT',
    evidence_quote: 'return join(root, key)',
    ...overrides
  }
}

function jsonResponse(status, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body
    }
  }
}

function makeRouter(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase()
    const record = { url, method, headers: init.headers, rawBody: init.body }
    calls.push(record)
    for (const route of routes) {
      if (route.match(url, method, record)) {
        return route.respond(url, method, record, calls.length)
      }
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`)
  }
  return { fetchImpl, calls }
}

function makeTempRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-publish-'))
  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(dir, relativePath)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

function blobSha(content) {
  const buffer = Buffer.from(content, 'utf8')
  return createHash('sha1').update(`blob ${buffer.length}\0`, 'utf8').update(buffer).digest('hex')
}

async function withNoEnvToken(fn) {
  const savedToken = process.env.GITHUB_TOKEN
  const savedGhToken = process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
  try {
    return await fn()
  } finally {
    if (typeof savedToken === 'undefined') delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = savedToken
    if (typeof savedGhToken === 'undefined') delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = savedGhToken
  }
}

test('renderInlineCommentBody formats severity, lens, corroboration, and suggestion', () => {
  const body = renderInlineCommentBody({
    severity: 'HIGH',
    lens_id: 'security',
    title: 'Unvalidated path input',
    body: 'The path is joined without normalization.',
    suggestion: 'const safe = path.normalize(input)',
    corroborating_lenses: ['security', 'data-race-conditions']
  })
  assert.match(body, /\*\*\[HIGH \u00b7 security\]\*\* Unvalidated path input/)
  assert.match(body, /Corroborated by: security, data-race-conditions/)
  assert.match(body, /```suggestion/)
})

test('renderReviewMarkdown includes marker, head sha, intent, coverage, and audit footer', () => {
  const markdown = renderReviewMarkdown(makePayload())
  assert.ok(markdown.startsWith(REVIEW_MARKER))
  assert.ok(markdown.includes(`<!-- head_sha:${HEAD_SHA} -->`))
  assert.match(markdown, /## Hivemind Multi-Angle PR Review/)
  assert.match(markdown, /### Intent vs\. Code-Intent Alignment/)
  assert.match(markdown, /Intent verdict:\*\* PARTIAL/)
  assert.match(markdown, /Scope Creep files:/)
  assert.match(markdown, /Unfulfilled Claims:/)
  assert.match(markdown, /### Multi-Angle Swarm Coverage/)
  assert.match(markdown, /\| security \| completed \| 1 \|/)
  assert.match(markdown, /Limited diff coverage/i)
  assert.match(markdown, /bounded slice/i)
  assert.match(markdown, /not the entire diff/i)
  assert.match(markdown, /unknown, not absent/i)
  assert.match(markdown, /### Summary & Cross-Cutting Findings/)
  assert.match(markdown, /Missing negative-path test/)
  assert.match(markdown, /Inline comments anchored directly on diff lines: 1 of 1/)
  assert.match(markdown, /Synthesis audit/)
})

test('renderReviewMarkdown labels verified:false summary findings UNVERIFIED, not as actionable findings', () => {
  const markdown = renderReviewMarkdown(makePayload({
    summary_findings: [
      {
        lens_id: 'testing-verification',
        severity: 'LOW',
        title: 'Demoted anchor finding',
        body: 'The line anchor did not resolve inside the diff hunk.',
        verified: false,
        anchorable: false,
        demote_reason: 'line_not_anchorable'
      }
    ]
  }))
  assert.match(markdown, /\*\*\[UNVERIFIED \u00b7 LOW \u00b7 testing-verification\]\*\* Demoted anchor finding/)
  assert.match(markdown, /Anchor\/evidence not validated; not a verdict basis\./)
  assert.match(markdown, /Limited diff coverage/i)
  assert.doesNotMatch(markdown, /\*\*\[LOW \u00b7 testing-verification\]\*\* Demoted anchor finding/)
})

test('renderInlineCommentBody marks verified:false severe comments UNVERIFIED', () => {
  const body = renderInlineCommentBody(makeSevereFinding('BLOCKER', { verified: false }))
  assert.match(body, /\*\*\[UNVERIFIED \u00b7 BLOCKER \u00b7 security\]\*\* BLOCKER legacy finding/)
  assert.match(body, /Anchor\/evidence not validated; not a verdict basis\./)
  assert.doesNotMatch(body, /\*\*\[BLOCKER \u00b7 security\]\*\*/)
})

test('synthesizeReview keeps an unverified severe finding out of verified inline comments', () => {
  const packet = {
    schema_version: 1,
    pr_ref: {
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      canonical_url: 'https://github.com/acme/widgets/pull/7',
      short_ref: 'acme/widgets#7'
    },
    pr_meta: { number: 7, head_sha: HEAD_SHA, base_sha: 'c'.repeat(40) },
    files: [
      {
        path: 'src/runner.mjs',
        status: 'modified',
        is_binary: false,
        additions: 1,
        deletions: 0,
        hunk_ids: [],
        anchorable_new_lines: [],
        anchorable_old_lines: [],
        sha256: 'abc'
      }
    ],
    hunks: [],
    selected_lenses: [{ id: 'security', reason: 'core_always_on' }],
    waves: [['security']]
  }
  const payload = synthesizeReview(packet, [
    {
      schema_version: 1,
      lens_id: 'security',
      head_sha: HEAD_SHA,
      summary: 'One severe finding whose anchor is outside the diff.',
      findings: [
        makeSevereFinding('BLOCKER', {
          line: 999,
          line_start: 999,
          line_end: 999
        })
      ]
    }
  ])

  assert.equal(payload.inline_comments.length, 0)
  assert.equal(payload.summary_findings.length, 1)
  assert.equal(payload.summary_findings[0].verified, false)
  assert.notEqual(payload.summary_findings[0].severity, 'BLOCKER')

  const markdown = renderReviewMarkdown(payload)
  assert.match(markdown, /\*\*\[UNVERIFIED \u00b7 MEDIUM \u00b7 security\]\*\* BLOCKER legacy finding/)
  assert.match(markdown, /Anchor\/evidence not validated; not a verdict basis\./)
  assert.doesNotMatch(markdown, /\*\*\[MEDIUM \u00b7 security\]\*\* BLOCKER legacy finding/)
})

test('buildGitHubReviewApiBody builds a RIGHT-side review payload', () => {
  const api = buildGitHubReviewApiBody(makePayload())
  assert.equal(api.commit_id, HEAD_SHA)
  assert.equal(api.event, 'REQUEST_CHANGES')
  assert.ok(api.body.startsWith(REVIEW_MARKER))
  assert.equal(api.comments.length, 1)
  assert.equal(api.comments[0].path, 'src/runner.mjs')
  assert.equal(api.comments[0].line, 12)
  assert.equal(api.comments[0].side, 'RIGHT')
  assert.ok(api.comments[0].body.includes('HIGH \u00b7 security'))
  assert.ok(!('start_line' in api.comments[0]))
  assert.equal(buildGitHubReviewApiBody(makePayload(), 'COMMENT').event, 'COMMENT')
})

test('buildGitHubReviewApiBody only adds start_line for multi-line anchors', () => {
  const payload = makePayload({
    inline_comments: [
      {
        lens_id: 'security',
        severity: 'LOW',
        title: 'Range finding',
        body: 'Spans a block.',
        path: 'src/range.mjs',
        line: 20,
        line_end: 25,
        start_line: 15,
        side: 'RIGHT'
      }
    ]
  })
  const comment = buildGitHubReviewApiBody(payload).comments[0]
  assert.equal(comment.line, 20)
  assert.equal(comment.start_line, 15)
  assert.equal(comment.start_side, 'RIGHT')
})

test('publishPRReview dry_run never touches the network and writes preview files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-dry-'))
  try {
    let networkCalls = 0
    const result = await publishPRReview(makePayload(), {
      mode: 'dry_run',
      fetchImpl: async () => {
        networkCalls += 1
        throw new Error('network should not be called')
      },
      outMarkdownPath: join(dir, 'review.md'),
      outJsonPath: join(dir, 'review.json')
    })
    assert.equal(networkCalls, 0)
    assert.equal(result.mode, 'dry_run')
    assert.equal(result.posted, false)
    assert.equal(result.verdict, 'REQUEST_CHANGES')
    assert.equal(result.inline_comments_count, 1)
    assert.equal(result.summary_findings_count, 1)
    assert.equal(result.review_id, null)
    assert.ok(result.markdown_body.startsWith(REVIEW_MARKER))
    assert.ok(readFileSync(join(dir, 'review.md'), 'utf8').includes(REVIEW_MARKER))
    const planned = JSON.parse(readFileSync(join(dir, 'review.json'), 'utf8'))
    assert.equal(planned.event, 'REQUEST_CHANGES')
    assert.equal(planned.comments.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('publishPRReview accepts an APPROVE payload with complete unique specialist coverage', async () => {
  let networkCalls = 0
  const result = await publishPRReview(makeCompleteApprovePayload(), {
    mode: 'dry_run',
    fetchImpl: async () => {
      networkCalls += 1
      throw new Error('network should not be called')
    }
  })
  assert.equal(networkCalls, 0)
  assert.equal(result.verdict, 'APPROVE')
  assert.equal(result.posted, false)
})

test('publishPRReview rejects legacy APPROVE retaining severe findings before any network in dry_run', async () => {
  for (const severity of ['MEDIUM', 'HIGH', 'BLOCKER']) {
    for (const field of ['inline_comments', 'summary_findings']) {
      let networkCalls = 0
      await assert.rejects(
        () => publishPRReview(makeCompleteApprovePayload({
          [field]: [makeSevereFinding(severity)]
        }), {
          mode: 'dry_run',
          fetchImpl: async () => {
            networkCalls += 1
            throw new Error('network should not be called')
          }
        }),
        (error) => error.code === ERROR_CODES.SCHEMA_INVALID && error.exitCode === EXIT_CODES.VALIDATION,
        `dry_run APPROVE with an intact ${severity} ${field} entry must fail closed`
      )
      assert.equal(networkCalls, 0)
    }
  }
})

test('publishPRReview rejects legacy APPROVE retaining severe findings before any network in post', async () => {
  for (const severity of ['MEDIUM', 'HIGH', 'BLOCKER']) {
    for (const field of ['inline_comments', 'summary_findings']) {
      let networkCalls = 0
      await assert.rejects(
        () => publishPRReview(makeCompleteApprovePayload({
          [field]: [makeSevereFinding(severity)]
        }), {
          mode: 'post',
          confirm: true,
          token: 'test-token',
          fetchImpl: async () => {
            networkCalls += 1
            throw new Error('network should not be called')
          }
        }),
        (error) => error.code === ERROR_CODES.SCHEMA_INVALID && error.exitCode === EXIT_CODES.VALIDATION,
        `post APPROVE with an intact ${severity} ${field} entry must fail closed`
      )
      assert.equal(networkCalls, 0)
    }
  }
})

test('publishPRReview rejects legacy zero-report APPROVE before any network in dry_run', async () => {
  const legacyApprove = makePayload({
    verdict: 'APPROVE',
    intent: { ...makeCompleteApprovePayload().intent },
    inline_comments: [],
    summary_findings: [],
    lens_coverage: [],
    stats: { subagent_reports: 0, selected_lenses: 0 }
  })
  let networkCalls = 0
  await assert.rejects(
    () => publishPRReview(legacyApprove, {
      mode: 'dry_run',
      fetchImpl: async () => {
        networkCalls += 1
        throw new Error('network should not be called')
      }
    }),
    (error) => error.code === ERROR_CODES.SCHEMA_INVALID && error.exitCode === EXIT_CODES.VALIDATION
  )
  assert.equal(networkCalls, 0)
})

test('publishPRReview allows APPROVE when severe findings are explicitly verified:false', async () => {
  let networkCalls = 0
  const result = await publishPRReview(makeCompleteApprovePayload({
    inline_comments: [makeSevereFinding('BLOCKER', { verified: false })],
    summary_findings: [makeSevereFinding('HIGH', { verified: false })]
  }), {
    mode: 'dry_run',
    fetchImpl: async () => {
      networkCalls += 1
      throw new Error('network should not be called')
    }
  })
  assert.equal(networkCalls, 0)
  assert.equal(result.verdict, 'APPROVE')
  assert.equal(result.posted, false)
})

test('publishPRReview rejects legacy zero-report APPROVE before any network in post', async () => {
  const legacyApprove = makePayload({
    verdict: 'APPROVE',
    intent: { ...makeCompleteApprovePayload().intent },
    inline_comments: [],
    summary_findings: [],
    lens_coverage: [
      { lens_id: 'intent-alignment', status: 'completed', finding_count: 0 },
      { lens_id: 'security', status: 'completed', finding_count: 0 }
    ],
    stats: { subagent_reports: 2, selected_lenses: 2 }
  })
  let networkCalls = 0
  await assert.rejects(
    () => publishPRReview(legacyApprove, {
      mode: 'post',
      confirm: true,
      token: 'test-token',
      fetchImpl: async () => {
        networkCalls += 1
        throw new Error('network should not be called')
      }
    }),
    (error) => error.code === ERROR_CODES.SCHEMA_INVALID && error.exitCode === EXIT_CODES.VALIDATION
  )
  assert.equal(networkCalls, 0)
})

test('publishPRReview post refuses without confirm true', async () => {
  let networkCalls = 0
  await assert.rejects(
    () => publishPRReview(makePayload(), {
      mode: 'post',
      token: 'test-token',
      fetchImpl: async () => {
        networkCalls += 1
        throw new Error('network should not be called')
      }
    }),
    (error) => error.code === ERROR_CODES.REFUSED && error.exitCode === EXIT_CODES.VALIDATION
  )
  assert.equal(networkCalls, 0)
})

test('publishPRReview rejects a stale head_sha before posting', async () => {
  const { fetchImpl, calls } = makeRouter([
    {
      match: (url, method) => method === 'GET' && /\/pulls\/7$/.test(url),
      respond: () => jsonResponse(200, { head: { sha: LIVE_OTHER_SHA } })
    }
  ])
  await assert.rejects(
    () => publishPRReview(makePayload(), {
      mode: 'post',
      confirm: true,
      token: 'test-token',
      fetchImpl
    }),
    (error) => error.code === ERROR_CODES.STALE_HEAD_SHA && error.exitCode === EXIT_CODES.STALE_HEAD
  )
  assert.equal(calls.length, 1)
})

test('publishPRReview rejects a duplicate marker review for the same head_sha', async () => {
  const { fetchImpl, calls } = makeRouter([
    {
      match: (url, method) => method === 'GET' && /\/pulls\/7$/.test(url),
      respond: () => jsonResponse(200, { head: { sha: HEAD_SHA } })
    },
    {
      match: (url, method) => method === 'GET' && url.includes('/pulls/7/reviews?per_page=100'),
      respond: () => jsonResponse(200, [
        { id: 1, body: `${REVIEW_MARKER}\n<!-- head_sha:${HEAD_SHA} -->` }
      ])
    }
  ])
  await assert.rejects(
    () => publishPRReview(makePayload(), {
      mode: 'post',
      confirm: true,
      token: 'test-token',
      fetchImpl
    }),
    (error) => error.code === ERROR_CODES.DUPLICATE_REVIEW && error.exitCode === EXIT_CODES.NOT_FOUND_OR_REFUSED
  )
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0)
})

test('publishPRReview downgrades a self-review 422 to COMMENT once', async () => {
  const { fetchImpl, calls } = makeRouter([
    {
      match: (url, method) => method === 'GET' && /\/pulls\/7$/.test(url),
      respond: () => jsonResponse(200, { head: { sha: HEAD_SHA } })
    },
    {
      match: (url, method) => method === 'GET' && url.includes('/pulls/7/reviews?per_page=100'),
      respond: () => jsonResponse(200, [])
    },
    {
      match: (url, method) => method === 'POST' && url.endsWith('/pulls/7/reviews'),
      respond: (url, method, record) => {
        const requestBody = JSON.parse(record.rawBody)
        if (requestBody.event !== 'COMMENT') {
          return jsonResponse(422, { message: 'Can not approve your own pull request' })
        }
        return jsonResponse(200, {
          id: 99,
          html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-99'
        })
      }
    }
  ])

  const result = await publishPRReview(makePayload(), {
    mode: 'post',
    confirm: true,
    token: 'test-token',
    fetchImpl
  })

  assert.equal(result.posted, true)
  assert.equal(result.verdict, 'REQUEST_CHANGES')
  assert.equal(result.effective_event, 'COMMENT')
  assert.equal(result.downgraded_self_review, true)
  assert.equal(result.review_id, 99)
  assert.equal(result.review_url, 'https://github.com/acme/widgets/pull/7#pullrequestreview-99')

  const postCalls = calls.filter((call) => call.method === 'POST')
  assert.equal(postCalls.length, 2)
  assert.equal(JSON.parse(postCalls[0].rawBody).event, 'REQUEST_CHANGES')
  assert.equal(JSON.parse(postCalls[1].rawBody).event, 'COMMENT')
})

test('publishRepoPullRequest rejects a PR body without required sections', async () => {
  const dir = makeTempRepo({ 'README.md': 'hello\n' })
  try {
    await assert.rejects(
      () => publishRepoPullRequest({
        workDir: dir,
        owner: 'acme',
        repo: 'widgets',
        title: 'Add feature',
        body: 'Just a summary.',
        token: 'test-token',
        fetchImpl: async () => {
          throw new Error('network should not be called')
        }
      }),
      (error) => error.code === ERROR_CODES.REFUSED && error.exitCode === EXIT_CODES.NOT_FOUND_OR_REFUSED
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('publishRepoPullRequest writes a deterministic bundle and refuses without a token', async () => {
  const dir = makeTempRepo({
    'README.md': 'hello\n',
    'src/app.mjs': 'export const app = true\n'
  })
  const bundleDir = join(dir, 'bundle')
  try {
    await withNoEnvToken(async () => {
      await assert.rejects(
        () => publishRepoPullRequest({
          workDir: dir,
          owner: 'acme',
          repo: 'widgets',
          title: 'Add feature',
          body: GOOD_BODY,
          bundleOutPath: bundleDir,
          fetchImpl: async () => {
            throw new Error('network should not be called')
          }
        }),
        (error) => error.code === ERROR_CODES.AUTH_REQUIRED && error.exitCode === EXIT_CODES.NOT_FOUND_OR_REFUSED
      )
    })
    const bundle = JSON.parse(readFileSync(join(bundleDir, 'publication-bundle.json'), 'utf8'))
    assert.equal(bundle.owner, 'acme')
    assert.equal(bundle.repo, 'widgets')
    assert.equal(bundle.pull_request, null)
    assert.deepEqual(bundle.files.map((file) => file.path), ['README.md', 'src/app.mjs'])
    assert.ok(bundle.files.every((file) => file.status === 'local' && typeof file.sha === 'string'))
    assert.ok(existsSync(join(bundleDir, 'publication-bundle.md')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('publishRepoPullRequest runs the direct Git Data flow with add, modify, and delete', async () => {
  const readme = 'hello\n'
  const newFile = 'export const added = true\n'
  const dir = makeTempRepo({
    'README.md': readme,
    'src/new.mjs': newFile
  })
  const readmeSha = blobSha(readme)
  const routes = [
    {
      match: (url, method) => method === 'GET' && url.endsWith('/repos/acme/widgets'),
      respond: () => jsonResponse(200, { full_name: 'acme/widgets', permissions: { push: true } })
    },
    {
      match: (url, method) => method === 'GET' && url.includes('/pulls?state=open&head='),
      respond: () => jsonResponse(200, [])
    },
    {
      match: (url, method) => method === 'GET' && url.endsWith('/git/ref/heads/main'),
      respond: () => jsonResponse(200, { object: { sha: 'base-commit' } })
    },
    {
      match: (url, method) => method === 'GET' && url.endsWith('/git/commits/base-commit'),
      respond: () => jsonResponse(200, { tree: { sha: 'base-tree' } })
    },
    {
      match: (url, method) => method === 'GET' && url.includes('/git/trees/base-tree?recursive=1'),
      respond: () => jsonResponse(200, {
        tree: [
          { path: 'README.md', type: 'blob', sha: readmeSha },
          { path: 'src/removed.mjs', type: 'blob', sha: 'removed-sha' }
        ]
      })
    },
    {
      match: (url, method) => method === 'POST' && url.endsWith('/git/blobs'),
      respond: () => jsonResponse(201, { sha: 'blob-new' })
    },
    {
      match: (url, method) => method === 'POST' && url.endsWith('/git/trees'),
      respond: () => jsonResponse(201, { sha: 'new-tree' })
    },
    {
      match: (url, method) => method === 'POST' && url.endsWith('/git/commits'),
      respond: () => jsonResponse(201, { sha: 'new-commit' })
    },
    {
      match: (url, method) => method === 'PATCH' && url.includes('/git/refs/heads/feat/pr-review-swarm'),
      respond: () => jsonResponse(200, { object: { sha: 'new-commit' } })
    },
    {
      match: (url, method) => method === 'POST' && url.endsWith('/pulls'),
      respond: () => jsonResponse(201, {
        number: 42,
        html_url: 'https://github.com/acme/widgets/pull/42'
      })
    }
  ]
  const { fetchImpl, calls } = makeRouter(routes)
  try {
    const result = await publishRepoPullRequest({
      workDir: dir,
      owner: 'acme',
      repo: 'widgets',
      title: 'Add feature',
      body: GOOD_BODY,
      token: 'test-token',
      allowPrune: true,
      fetchImpl
    })

    assert.equal(result.created, true)
    assert.equal(result.pr_url, 'https://github.com/acme/widgets/pull/42')
    assert.equal(result.number, 42)
    assert.equal(result.direct, true)
    assert.equal(result.head, 'acme:feat/pr-review-swarm')
    assert.equal(result.head_sha, 'new-commit')
    assert.deepEqual(result.changes.map((change) => change.status), ['added', 'deleted'])

    const blobCalls = calls.filter((call) => call.method === 'POST' && call.url.endsWith('/git/blobs'))
    assert.equal(blobCalls.length, 1)

    const treeCall = calls.find((call) => call.method === 'POST' && call.url.endsWith('/git/trees'))
    const treeBody = JSON.parse(treeCall.rawBody)
    assert.equal(treeBody.base_tree, 'base-tree')
    assert.deepEqual(treeBody.tree.map((entry) => [entry.path, entry.sha]), [
      ['src/new.mjs', 'blob-new'],
      ['src/removed.mjs', null]
    ])

    const commitCall = calls.find((call) => call.method === 'POST' && call.url.endsWith('/git/commits'))
    const commitBody = JSON.parse(commitCall.rawBody)
    assert.deepEqual(commitBody.parents, ['base-commit'])
    assert.equal(commitBody.tree, 'new-tree')

    const pullCall = calls.find((call) => call.method === 'POST' && call.url.endsWith('/pulls'))
    const pullBody = JSON.parse(pullCall.rawBody)
    assert.equal(pullBody.head, 'acme:feat/pr-review-swarm')
    assert.equal(pullBody.base, 'main')
    assert.ok(pullBody.body.includes('## Problem Statement'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('publishRepoPullRequest returns an existing open PR without re-uploading', async () => {
  const dir = makeTempRepo({ 'README.md': 'hello\n' })
  const routes = [
    {
      match: (url, method) => method === 'GET' && url.endsWith('/repos/acme/widgets'),
      respond: () => jsonResponse(200, { permissions: { push: true } })
    },
    {
      match: (url, method) => method === 'GET' && url.includes('/pulls?state=open&head='),
      respond: () => jsonResponse(200, [
        {
          number: 5,
          html_url: 'https://github.com/acme/widgets/pull/5',
          head: { sha: 'existing' }
        }
      ])
    }
  ]
  const { fetchImpl, calls } = makeRouter(routes)
  try {
    const result = await publishRepoPullRequest({
      workDir: dir,
      owner: 'acme',
      repo: 'widgets',
      title: 'Add feature',
      body: GOOD_BODY,
      token: 'test-token',
      fetchImpl
    })
    assert.equal(result.created, false)
    assert.equal(result.number, 5)
    assert.equal(result.pr_url, 'https://github.com/acme/widgets/pull/5')
    assert.equal(result.head_sha, 'existing')
    assert.ok(!calls.some((call) => call.method === 'POST'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('publishRepoPullRequest forks, creates a missing ref, and opens a cross-fork PR', async () => {
  const dir = makeTempRepo({ 'src/fork.mjs': 'export const forked = true\n' })
  const routes = [
    {
      match: (url, method) => method === 'GET' && url.endsWith('/repos/acme/widgets'),
      respond: () => jsonResponse(200, { permissions: { push: false } })
    },
    {
      match: (url, method) => method === 'GET' && url.endsWith('/user'),
      respond: () => jsonResponse(200, { login: 'reviewer' })
    },
    {
      match: (url, method) => method === 'POST' && url.endsWith('/forks'),
      respond: () => jsonResponse(202, {
        full_name: 'reviewer/widgets',
        owner: { login: 'reviewer' }
      })
    },
    {
      match: (url, method) => method === 'GET' && url.includes('/pulls?state=open&head='),
      respond: () => jsonResponse(200, [])
    },
    {
      match: (url, method) => method === 'GET' && url.endsWith('/git/ref/heads/main'),
      respond: () => jsonResponse(200, { object: { sha: 'base-commit' } })
    },
    {
      match: (url, method) => method === 'GET' && url.endsWith('/git/commits/base-commit'),
      respond: () => jsonResponse(200, { tree: { sha: 'base-tree' } })
    },
    {
      match: (url, method) => method === 'GET' && url.includes('/git/trees/base-tree?recursive=1'),
      respond: () => jsonResponse(200, { tree: [] })
    },
    {
      match: (url, method) => method === 'POST' && url.endsWith('/git/blobs'),
      respond: () => jsonResponse(201, { sha: 'fork-blob' })
    },
    {
      match: (url, method) => method === 'POST' && url.endsWith('/git/trees'),
      respond: () => jsonResponse(201, { sha: 'fork-tree' })
    },
    {
      match: (url, method) => method === 'POST' && url.endsWith('/git/commits'),
      respond: () => jsonResponse(201, { sha: 'fork-commit' })
    },
    {
      match: (url, method) => method === 'PATCH' && url.includes('/repos/reviewer/widgets/git/refs/heads/'),
      respond: () => jsonResponse(404, { message: 'Not Found' })
    },
    {
      match: (url, method) => method === 'POST' && url.endsWith('/repos/reviewer/widgets/git/refs'),
      respond: () => jsonResponse(201, { ref: 'refs/heads/feat/pr-review-swarm' })
    },
    {
      match: (url, method) => method === 'POST' && url.endsWith('/repos/acme/widgets/pulls'),
      respond: () => jsonResponse(201, {
        number: 8,
        html_url: 'https://github.com/acme/widgets/pull/8'
      })
    }
  ]
  const { fetchImpl, calls } = makeRouter(routes)
  try {
    const result = await publishRepoPullRequest({
      workDir: dir,
      owner: 'acme',
      repo: 'widgets',
      title: 'Add feature',
      body: GOOD_BODY,
      token: 'test-token',
      fetchImpl
    })

    assert.equal(result.created, true)
    assert.equal(result.direct, false)
    assert.equal(result.fork.owner, 'reviewer')
    assert.equal(result.head, 'reviewer:feat/pr-review-swarm')
    assert.equal(result.pr_url, 'https://github.com/acme/widgets/pull/8')

    const refCall = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/repos/reviewer/widgets/git/refs')
    )
    assert.ok(refCall)
    assert.equal(JSON.parse(refCall.rawBody).ref, 'refs/heads/feat/pr-review-swarm')

    const pullCall = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/repos/acme/widgets/pulls')
    )
    assert.equal(JSON.parse(pullCall.rawBody).head, 'reviewer:feat/pr-review-swarm')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})