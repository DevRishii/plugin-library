#!/usr/bin/env node
/**
 * Zero-dependency command-line interface for the Hivemind `/pr-review` swarm.
 *
 * Two equivalent artifact conventions are supported:
 *   1. Run directory: packet.json, slices/<lens>.json, reports/<lens>.json,
 *      synthesis.json, review.md, publish.json.
 *   2. Explicit paths: --packet, --report, --payload and --out.
 *
 * Every command is a thin orchestration layer over the shared contract modules;
 * no exit code, lens id, schema, or envelope shape is redefined here.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  BUDGETS,
  ERROR_CODES,
  EXIT_CODES,
  INTENT_VERDICTS,
  LENS_BY_ID,
  LENS_REGISTRY,
  REVIEW_MARKER,
  SCHEMA_VERSION,
  SEVERITIES,
  ContractError,
  formatJsonError,
  formatJsonSuccess,
  partitionLensesIntoWaves,
  quarantineUntrustedText,
  selectLensesForFiles,
  validatePRContextPacket,
  validateSubagentReviewReport
} from './contracts.mjs'
import { ingestPullRequest } from './ingest.mjs'
import { parseUnifiedDiff } from './diff-parser.mjs'
import { buildLensSlice, buildWaveDispatchPlan } from './slicer.mjs'
import { renderLensWorkerPrompt } from './prompts.mjs'
import { evaluateIntentAlignment } from './intent.mjs'
import { synthesizeReview, verifyFindingEvidence } from './synthesize.mjs'
import { renderReviewMarkdown } from './render.mjs'
import { publishPRReview } from './publish.mjs'
import { publishRepoPullRequest } from './git-api-pr.mjs'

const VALUE_FLAGS = new Set([
  'pr', 'pr-file', 'from-fixture', 'run-dir', 'out', 'max-parallel', 'only-lenses',
  'extra-lenses', 'files', 'packet', 'lens', 'max-lines', 'report', 'payload',
  'api-base', 'work-dir', 'owner', 'repo', 'branch', 'title-file', 'body-file',
  'base', 'bundle-out'
])

const BOOLEAN_FLAGS = new Set([
  'json', 'write-run', 'strict-approve', 'allow-medium-approve', 'dry-run', 'post',
  'confirm', 'force', 'help'
])

const USAGE = `Usage: pr-review <command> [options]

Commands:
  ingest [<pr-ref>] [--pr-file <file>] [--from-fixture <dir>] [--run-dir <dir>]
          [--write-run] [--out <file>] [--max-parallel <n>]
          [--only-lenses a,b] [--extra-lenses a,b] [--json]
  lenses [--files <file-or-comma-list>] [--json]
  slice --lens <id> [--run-dir <dir> | --packet <file>] [--max-lines <n>]
        [--out <file>] [--json]
  prompt --lens <id> [--run-dir <dir> | --packet <file>] [--out <file>] [--json]
  validate-report [<report-path>] [--lens <id>] [--run-dir <dir>]
                  [--packet <file>] [--report <file>] [--json]
  synthesize [--run-dir <dir>] [--packet <file>] [<report-paths...>]
             [--out <file>] [--allow-medium-approve] [--json]
  render [--run-dir <dir> | --payload <file> | <payload-path>] [--out <file>] [--json]
  publish [--run-dir <dir> | --payload <file> | <payload-path>] [--dry-run | --post]
          [--confirm] [--force] [--api-base <url>] [--json]
  open-repo-pr --work-dir <dir> --owner <owner> --repo <repo> --branch <branch>
               --title-file <path> --body-file <path> [--base <branch>]
               [--bundle-out <path>] [--json]
  selftest [--json]

Exit codes: 0 ok, 1 internal, 2 validation, 3 not found/refused, 4 stale head.
`

function parseArgs(argv = []) {
  const flags = Object.create(null)
  const positionals = []
  const args = Array.isArray(argv) ? argv.map(String) : []

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (arg === '-h') {
      flags.help = true
      continue
    }
    if (!arg.startsWith('--')) {
      if (arg.startsWith('-')) {
        throw new ContractError(ERROR_CODES.INVALID_INPUT, `Unknown option: ${arg}`, EXIT_CODES.VALIDATION)
      }
      positionals.push(arg)
      continue
    }

    const eq = arg.indexOf('=')
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2)
    if (VALUE_FLAGS.has(key)) {
      let value
      if (eq >= 0) {
        value = arg.slice(eq + 1)
      } else {
        value = args[i + 1]
        if (value === undefined || value.startsWith('--')) {
          throw new ContractError(ERROR_CODES.INVALID_INPUT, `Option --${key} requires a value`, EXIT_CODES.VALIDATION)
        }
        i += 1
      }
      if (key === 'report' && flags.report !== undefined) {
        const previous = Array.isArray(flags.report) ? flags.report : [flags.report]
        flags.report = [...previous, value]
      } else {
        flags[key] = value
      }
      continue
    }
    if (!BOOLEAN_FLAGS.has(key)) {
      throw new ContractError(ERROR_CODES.INVALID_INPUT, `Unknown option: --${key}`, EXIT_CODES.VALIDATION)
    }
    if (eq >= 0) {
      throw new ContractError(ERROR_CODES.INVALID_INPUT, `Option --${key} does not take a value`, EXIT_CODES.VALIDATION)
    }
    flags[key] = true
  }

  return { flags, positionals }
}

function splitList(value) {
  if (value === undefined) return undefined
  const values = Array.isArray(value) ? value : [value]
  return values
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function readTextFile(filePath, label) {
  try {
    return readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new ContractError(ERROR_CODES.NOT_FOUND, `${label} not found: ${filePath}`, EXIT_CODES.NOT_FOUND_OR_REFUSED)
    }
    throw error
  }
}

function readJsonFile(filePath, label) {
  const text = readTextFile(filePath, label)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ContractError(
      ERROR_CODES.SCHEMA_INVALID,
      `Invalid JSON in ${label} (${filePath}): ${error.message}`,
      EXIT_CODES.VALIDATION
    )
  }
}

function writeTextFile(filePath, text) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, String(text), 'utf8')
}

function writeJsonFile(filePath, value) {
  writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function ensureRunDir(runDir) {
  mkdirSync(runDir, { recursive: true })
  mkdirSync(join(runDir, 'slices'), { recursive: true })
  mkdirSync(join(runDir, 'reports'), { recursive: true })
  return runDir
}

function positiveInt(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) {
    throw new ContractError(ERROR_CODES.INVALID_INPUT, `${label} must be a positive integer`, EXIT_CODES.VALIDATION)
  }
  return number
}

function requireFlag(flags, name) {
  const value = flags[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new ContractError(ERROR_CODES.INVALID_INPUT, `Missing required --${name}`, EXIT_CODES.VALIDATION)
  }
  return value.trim()
}

function envToken(env) {
  return String(env.GITHUB_TOKEN || env.GH_TOKEN || '').trim() || undefined
}

function readPacketFile(filePath) {
  const packet = readJsonFile(filePath, 'PR context packet')
  return validatePRContextPacket(packet)
}

function loadPacket(flags) {
  if (typeof flags.packet === 'string') return readPacketFile(resolve(flags.packet))
  if (typeof flags['run-dir'] === 'string') {
    return readPacketFile(join(resolve(flags['run-dir']), 'packet.json'))
  }
  throw new ContractError(
    ERROR_CODES.INVALID_INPUT,
    'Provide --run-dir <dir> or --packet <file>',
    EXIT_CODES.VALIDATION
  )
}

function loadPayloadPath(flags, positionals) {
  if (typeof flags.payload === 'string') return resolve(flags.payload)
  if (positionals.length > 0) return resolve(positionals[0])
  if (typeof flags['run-dir'] === 'string') {
    return join(resolve(flags['run-dir']), 'synthesis.json')
  }
  throw new ContractError(
    ERROR_CODES.INVALID_INPUT,
    'Provide --run-dir <dir>, --payload <file>, or a payload path',
    EXIT_CODES.VALIDATION
  )
}

function lensIdOf(selection) {
  return typeof selection === 'string' ? selection : selection && selection.id
}

function writeResult(io, flags, data, humanText) {
  if (flags.json) {
    io.stdout.write(`${formatJsonSuccess(data)}\n`)
  } else {
    io.stdout.write(`${String(humanText).replace(/\n?$/, '\n')}`)
  }
}

function readChangedFilesArg(rawValue) {
  const value = String(rawValue)
  const parts = value.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (parts.length === 1 && /\.(txt|list)$/i.test(parts[0]) && existsSync(resolve(parts[0]))) {
    return readTextFile(resolve(parts[0]), 'Changed-file list')
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  return parts
}

async function commandIngest(ctx) {
  const { io, flags, positionals, env } = ctx
  let ref = positionals[0]
  if (!ref && typeof flags.pr === 'string') ref = flags.pr
  if (!ref && typeof flags['pr-file'] === 'string') {
    ref = readTextFile(resolve(flags['pr-file']), 'PR ref file').trim()
  }
  if (!ref) {
    throw new ContractError(
      ERROR_CODES.INVALID_PR_REF,
      'Provide a PR reference argument, --pr-file <file>, or --pr <ref>',
      EXIT_CODES.VALIDATION
    )
  }

  const onlyLenses = splitList(flags['only-lenses'])
  const extraLenses = splitList(flags['extra-lenses'])
  for (const lensId of [...(onlyLenses ?? []), ...(extraLenses ?? [])]) {
    if (!LENS_BY_ID[lensId]) {
      throw new ContractError(ERROR_CODES.INVALID_INPUT, `Unknown lens: ${lensId}`, EXIT_CODES.VALIDATION)
    }
  }

  const packet = await ingestPullRequest(ref, {
    fixtureDir: typeof flags['from-fixture'] === 'string' ? resolve(flags['from-fixture']) : undefined,
    maxParallel: flags['max-parallel'] === undefined ? undefined : positiveInt(flags['max-parallel'], '--max-parallel'),
    onlyLenses,
    extraLenses,
    token: envToken(env)
  })

  let runDir = typeof flags['run-dir'] === 'string' ? resolve(flags['run-dir']) : null
  if (!runDir && flags['write-run']) {
    runDir = resolve(
      '.opencode',
      'pr-review',
      `${packet.pr_ref.owner}-${packet.pr_ref.repo}-${packet.pr_ref.number}`
    )
  }
  if (runDir) {
    ensureRunDir(runDir)
    writeJsonFile(join(runDir, 'packet.json'), packet)
    for (const selection of packet.selected_lenses) {
      const lensId = lensIdOf(selection)
      if (!lensId) continue
      writeJsonFile(join(runDir, 'slices', `${lensId}.json`), buildLensSlice(packet, lensId))
    }
  }

  if (typeof flags.out === 'string') writeJsonFile(resolve(flags.out), packet)

  const dispatchPlan = buildWaveDispatchPlan(packet, {
    maxParallel: flags['max-parallel'] === undefined
      ? BUDGETS.DEFAULT_MAX_PARALLEL
      : positiveInt(flags['max-parallel'], '--max-parallel')
  })
  const data = {
    run_dir: runDir,
    pr_ref: packet.pr_ref,
    pr_meta: packet.pr_meta,
    stated_intent: {
      has_problem_statement: packet.stated_intent.has_problem_statement === true,
      has_solution: packet.stated_intent.has_solution === true,
      claims_count: Array.isArray(packet.stated_intent.claims) ? packet.stated_intent.claims.length : 0
    },
    selected_lenses: packet.selected_lenses,
    waves: packet.waves,
    dispatch_plan: dispatchPlan,
    transport_used: packet.transport_used
  }

  const lensCount = packet.selected_lenses.length
  const human = [
    `PR: ${packet.pr_ref.canonical_url}`,
    `Head SHA: ${packet.pr_meta.head_sha}`,
    `Run dir: ${runDir ?? '(not written)'}`,
    `Stated intent: Problem Statement ${data.stated_intent.has_problem_statement ? 'found' : 'missing'} | Solution ${data.stated_intent.has_solution ? 'found' : 'missing'}`,
    `Selected lenses: ${lensCount} in ${packet.waves.length} wave(s)`,
    ...packet.waves.map((wave, index) => `Wave ${index + 1}: ${wave.join(', ')}`)
  ].join('\n')
  writeResult(io, flags, data, human)
  return EXIT_CODES.OK
}

function commandLenses(ctx) {
  const { io, flags } = ctx
  let files = null
  if (typeof flags.files === 'string') files = readChangedFilesArg(flags.files)
  const selected = files ? selectLensesForFiles(files) : null
  const data = {
    total: LENS_REGISTRY.length,
    core_count: LENS_REGISTRY.filter((lens) => lens.always_on).length,
    conditional_count: LENS_REGISTRY.filter((lens) => !lens.always_on).length,
    lenses: LENS_REGISTRY.map((lens) => ({
      id: lens.id,
      title: lens.title,
      category: lens.category,
      wave: lens.wave,
      always_on: lens.always_on,
      triggers: [...lens.triggers]
    }))
  }
  if (files) {
    data.files = files
    data.selected = selected
    data.selected_lenses = selected.map((entry) => entry.id)
  }

  const human = files
    ? `Selected ${selected.length} lens(es) for ${files.length} file(s):\n${selected.map((entry) => `- ${entry.id} (${entry.reason})`).join('\n')}`
    : LENS_REGISTRY.map((lens) => {
      const trigger = lens.always_on ? 'always on' : `trigger: ${lens.triggers.join(' | ')}`
      return `- ${lens.id} [${lens.category}] wave ${lens.wave} (${trigger})`
    }).join('\n')
  writeResult(io, flags, data, human)
  return EXIT_CODES.OK
}

function commandSlice(ctx) {
  const { io, flags } = ctx
  const lensId = requireFlag(flags, 'lens')
  const packet = loadPacket(flags)
  const slice = buildLensSlice(packet, lensId, {
    maxLines: flags['max-lines'] === undefined ? undefined : positiveInt(flags['max-lines'], '--max-lines')
  })
  const runDir = typeof flags['run-dir'] === 'string' ? resolve(flags['run-dir']) : null
  const outPath = typeof flags.out === 'string'
    ? resolve(flags.out)
    : runDir
      ? join(runDir, 'slices', `${lensId}.json`)
      : null
  if (outPath) writeJsonFile(outPath, slice)
  const data = outPath ? { ...slice, out_path: outPath } : slice
  writeResult(
    io,
    flags,
    data,
    `Lens ${lensId}: ${slice.hunks.length} hunk(s), ${slice.included_files.length}/${slice.total_files_in_pr} file(s), ${slice.line_count} line(s), ~${slice.estimated_tokens} tokens${outPath ? ` -> ${outPath}` : ''}`
  )
  return EXIT_CODES.OK
}

function commandPrompt(ctx) {
  const { io, flags } = ctx
  const lensId = requireFlag(flags, 'lens')
  const packet = loadPacket(flags)
  const runDir = typeof flags['run-dir'] === 'string' ? resolve(flags['run-dir']) : null
  const slicePath = runDir ? join(runDir, 'slices', `${lensId}.json`) : null
  const slice = slicePath && existsSync(slicePath)
    ? readJsonFile(slicePath, 'Lens slice')
    : buildLensSlice(packet, lensId, {
      maxLines: flags['max-lines'] === undefined ? undefined : positiveInt(flags['max-lines'], '--max-lines')
    })
  const prompt = renderLensWorkerPrompt(packet, slice)
  if (typeof flags.out === 'string') writeTextFile(resolve(flags.out), prompt)
  if (flags.json) {
    io.stdout.write(`${formatJsonSuccess({ lens_id: lensId, prompt })}\n`)
  } else {
    io.stdout.write(prompt.endsWith('\n') ? prompt : `${prompt}\n`)
  }
  return EXIT_CODES.OK
}

function commandValidateReport(ctx) {
  const { io, flags, positionals } = ctx
  const lensFlag = typeof flags.lens === 'string' ? flags.lens.trim() : null
  if (lensFlag && !LENS_BY_ID[lensFlag]) {
    throw new ContractError(ERROR_CODES.INVALID_INPUT, `Unknown lens: ${lensFlag}`, EXIT_CODES.VALIDATION)
  }

  let reportPath = positionals[0] ? resolve(positionals[0]) : null
  if (!reportPath && typeof flags.report === 'string') reportPath = resolve(flags.report)
  if (!reportPath && Array.isArray(flags.report) && flags.report.length > 0) reportPath = resolve(flags.report[0])
  if (!reportPath) {
    if (!lensFlag) {
      throw new ContractError(
        ERROR_CODES.INVALID_INPUT,
        'Provide a report path or --lens <id> with --run-dir',
        EXIT_CODES.VALIDATION
      )
    }
    if (typeof flags['run-dir'] !== 'string') {
      throw new ContractError(
        ERROR_CODES.INVALID_INPUT,
        'Provide --run-dir <dir> when resolving reports/<lens>.json',
        EXIT_CODES.VALIDATION
      )
    }
    reportPath = join(resolve(flags['run-dir']), 'reports', `${lensFlag}.json`)
  }

  const report = validateSubagentReviewReport(readJsonFile(reportPath, 'Review report'))
  if (lensFlag && report.lens_id !== lensFlag) {
    throw new ContractError(
      ERROR_CODES.INVALID_INPUT,
      `Report lens_id ${report.lens_id} does not match --lens ${lensFlag}`,
      EXIT_CODES.VALIDATION
    )
  }

  let packet = null
  if (typeof flags.packet === 'string') packet = readPacketFile(resolve(flags.packet))
  else if (typeof flags['run-dir'] === 'string') packet = readPacketFile(join(resolve(flags['run-dir']), 'packet.json'))

  let verifiedAnchorable = null
  let demoted = null
  let droppedHallucinated = null
  if (packet) {
    verifiedAnchorable = 0
    demoted = 0
    droppedHallucinated = 0
    for (const finding of report.findings) {
      const result = verifyFindingEvidence(packet, finding)
      if (result.verified === true) verifiedAnchorable += 1
      if (result.file_in_diff === false) droppedHallucinated += 1
      else if (result.verified !== true) demoted += 1
    }
  }

  const data = {
    valid: true,
    lens_id: report.lens_id,
    report_path: reportPath,
    total_findings: report.findings.length,
    verified_anchorable: verifiedAnchorable,
    demoted,
    dropped_hallucinated: droppedHallucinated
  }
  writeResult(
    io,
    flags,
    data,
    `Valid ${report.lens_id} report: ${report.findings.length} finding(s), ${verifiedAnchorable ?? 'n/a'} anchorable, ${demoted ?? 'n/a'} demoted, ${droppedHallucinated ?? 'n/a'} dropped`
  )
  return EXIT_CODES.OK
}

function collectReportPaths(flags, positionals) {
  const paths = []
  for (const pos of positionals) paths.push(resolve(pos))
  if (typeof flags.report === 'string') paths.push(resolve(flags.report))
  else if (Array.isArray(flags.report)) {
    for (const r of flags.report) paths.push(resolve(r))
  }
  if (paths.length === 0 && typeof flags['run-dir'] === 'string') {
    const reportsDir = join(resolve(flags['run-dir']), 'reports')
    if (existsSync(reportsDir)) {
      for (const entry of readdirSync(reportsDir).sort()) {
        if (entry.endsWith('.json')) paths.push(join(reportsDir, entry))
      }
    }
  }
  return [...new Set(paths)]
}

function commandSynthesize(ctx) {
  const { io, flags, positionals } = ctx
  const packet = loadPacket(flags)
  const reportPaths = collectReportPaths(flags, positionals)
  const reports = reportPaths.map((filePath) => readJsonFile(filePath, 'Subagent review report'))
  const strictApprove = !flags['allow-medium-approve']

  const payload = synthesizeReview(packet, reports, {
    strictApprove,
    renderMarkdown: renderReviewMarkdown
  })

  const runDir = typeof flags['run-dir'] === 'string' ? resolve(flags['run-dir']) : null
  if (runDir) {
    ensureRunDir(runDir)
    writeJsonFile(join(runDir, 'synthesis.json'), payload)
    writeTextFile(join(runDir, 'review.md'), payload.markdown_body || renderReviewMarkdown(payload))
  }
  if (typeof flags.out === 'string') {
    writeJsonFile(resolve(flags.out), payload)
  }

  const human = [
    `Verdict: ${payload.verdict} (intent: ${payload.intent.verdict})`,
    `Inline comments: ${payload.inline_comments.length} | Summary findings: ${payload.summary_findings.length}`,
    `Stats: raw=${payload.stats.raw_findings}, deduped=${payload.stats.deduplicated_merged}, dropped_hallucinated=${payload.stats.dropped_hallucinated_path}`,
    ...(runDir ? [`Wrote: ${join(runDir, 'synthesis.json')} and ${join(runDir, 'review.md')}`] : [])
  ].join('\n')

  writeResult(io, flags, payload, human)
  return EXIT_CODES.OK
}

function commandRender(ctx) {
  const { io, flags, positionals } = ctx
  const payloadPath = loadPayloadPath(flags, positionals)
  const payload = readJsonFile(payloadPath, 'Orchestrated PR review payload')
  const markdown = renderReviewMarkdown(payload)

  const runDir = typeof flags['run-dir'] === 'string' ? resolve(flags['run-dir']) : null
  const outPath = typeof flags.out === 'string'
    ? resolve(flags.out)
    : runDir
      ? join(runDir, 'review.md')
      : null
  if (outPath) writeTextFile(outPath, markdown)

  if (flags.json) {
    io.stdout.write(`${formatJsonSuccess({ verdict: payload.verdict, head_sha: payload.head_sha, out_path: outPath, markdown })}\n`)
  } else {
    io.stdout.write(markdown.endsWith('\n') ? markdown : `${markdown}\n`)
  }
  return EXIT_CODES.OK
}

async function commandPublish(ctx) {
  const { io, flags, positionals, env, fetchImpl } = ctx
  if (flags['dry-run'] && flags.post) {
    throw new ContractError(ERROR_CODES.INVALID_INPUT, 'Cannot pass both --dry-run and --post', EXIT_CODES.VALIDATION)
  }
  const payloadPath = loadPayloadPath(flags, positionals)
  const payload = readJsonFile(payloadPath, 'Orchestrated PR review payload')
  const runDir = typeof flags['run-dir'] === 'string' ? resolve(flags['run-dir']) : null

  const result = await publishPRReview(payload, {
    mode: flags.post ? 'post' : 'dry_run',
    confirm: Boolean(flags.confirm),
    force: Boolean(flags.force),
    apiBase: typeof flags['api-base'] === 'string' ? flags['api-base'].replace(/\/+$/, '') : undefined,
    token: envToken(env),
    fetchImpl,
    outMarkdownPath: typeof flags.out === 'string' ? resolve(flags.out) : (runDir ? join(runDir, 'review.md') : undefined),
    outJsonPath: runDir ? join(runDir, 'publish.json') : undefined
  })

  const human = result.posted
    ? `Published GitHub review (${result.effective_event}): ${result.review_url ?? result.review_id}`
    : `Dry-run review ready (${result.verdict}): ${result.inline_comments_count} inline, ${result.summary_findings_count} summary`
  writeResult(io, flags, result, human)
  return EXIT_CODES.OK
}

async function commandOpenRepoPr(ctx) {
  const { io, flags, env, fetchImpl } = ctx
  const workDir = resolve(requireFlag(flags, 'work-dir'))
  const owner = requireFlag(flags, 'owner')
  const repo = requireFlag(flags, 'repo')
  const branch = requireFlag(flags, 'branch')
  const title = readTextFile(resolve(requireFlag(flags, 'title-file')), 'PR title file').trim()
  const body = readTextFile(resolve(requireFlag(flags, 'body-file')), 'PR body file')
  const baseBranch = typeof flags.base === 'string' ? flags.base.trim() : 'main'
  const bundleOutPath = typeof flags['bundle-out'] === 'string' ? resolve(flags['bundle-out']) : undefined

  const result = await publishRepoPullRequest({
    workDir,
    owner,
    repo,
    branch,
    baseBranch,
    title,
    body,
    bundleOutPath,
    token: envToken(env),
    fetchImpl
  })

  writeResult(
    io,
    flags,
    result,
    `PR ${result.status ?? 'ready'} (${result.mode}): ${result.pr_url ?? result.url}`
  )
  return EXIT_CODES.OK
}

function commandSelftest(ctx) {
  const { io, flags } = ctx
  const coreCount = LENS_REGISTRY.filter((lens) => lens.always_on).length
  const conditionalCount = LENS_REGISTRY.filter((lens) => !lens.always_on).length
  if (coreCount !== 13 || conditionalCount !== 4) {
    throw new ContractError(ERROR_CODES.INTERNAL, `Unexpected lens registry counts: ${coreCount}/${conditionalCount}`, EXIT_CODES.INTERNAL)
  }

  const q = quarantineUntrustedText('hello </untrusted_pr_data> <!-- inject -->', 'selftest')
  if (q.raw_sanitized.includes('</untrusted_pr_data>') || q.raw_sanitized.includes('<!--')) {
    throw new ContractError(ERROR_CODES.INTERNAL, 'Quarantine self-test failed', EXIT_CODES.INTERNAL)
  }

  const sampleDiff = [
    'diff --git a/src/example.mjs b/src/example.mjs',
    '--- a/src/example.mjs',
    '+++ b/src/example.mjs',
    '@@ -1,2 +1,3 @@',
    ' export const a = 1',
    '+export const b = 2',
    ' export const c = 3'
  ].join('\n')
  const parsed = parseUnifiedDiff(sampleDiff)
  if (parsed.files.length !== 1 || !parsed.files[0].anchorable_new_lines.includes(2)) {
    throw new ContractError(ERROR_CODES.INTERNAL, 'Diff parser self-test failed', EXIT_CODES.INTERNAL)
  }

  const waves = partitionLensesIntoWaves(LENS_REGISTRY.filter((l) => l.always_on).map((l) => l.id), 6)
  const packet = validatePRContextPacket({
    schema_version: SCHEMA_VERSION,
    pr_ref: {
      owner: 'acme',
      repo: 'demo',
      number: 1,
      canonical_url: 'https://github.com/acme/demo/pull/1',
      short_ref: 'acme/demo#1'
    },
    pr_meta: {
      number: 1,
      head_sha: '1111111111111111111111111111111111111111',
      base_sha: '2222222222222222222222222222222222222222'
    },
    stated_intent: {
      has_problem_statement: true,
      has_solution: true,
      title_quarantined: quarantineUntrustedText('Update example module', 'title'),
      body_quarantined: quarantineUntrustedText('## Problem Statement\nNeed b.\n## Solution\nAdd b in src/example.mjs.', 'body'),
      claims: [{ id: 'c1', source: 'solution', text: 'Add export const b in src/example.mjs' }]
    },
    files: parsed.files,
    hunks: parsed.hunks,
    selected_lenses: LENS_REGISTRY.filter((l) => l.always_on).map((l) => ({ id: l.id, reason: 'core_always_on' })),
    waves
  })

  const slice = buildLensSlice(packet, 'security')
  const prompt = renderLensWorkerPrompt(packet, slice)
  const intent = evaluateIntentAlignment(packet)
  if (!INTENT_VERDICTS.includes(intent.verdict) || !SEVERITIES.includes('BLOCKER')) {
    throw new ContractError(ERROR_CODES.INTERNAL, 'Intent self-test failed', EXIT_CODES.INTERNAL)
  }
  const synthesized = synthesizeReview(packet, [], { renderMarkdown: renderReviewMarkdown })
  if (!synthesized.markdown_body.includes(REVIEW_MARKER) || !prompt.includes('[NEW:2]')) {
    throw new ContractError(ERROR_CODES.INTERNAL, 'Synthesis/render self-test failed', EXIT_CODES.INTERNAL)
  }

  const data = {
    ok: true,
    schema_version: SCHEMA_VERSION,
    core_lenses: coreCount,
    conditional_lenses: conditionalCount,
    waves_at_cap_6: waves.length
  }
  writeResult(io, flags, data, `pr-review selftest: OK (${coreCount} core + ${conditionalCount} conditional lenses)`)
  return EXIT_CODES.OK
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const io = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr
  }
  const env = options.env ?? process.env
  const fetchImpl = options.fetchImpl

  try {
    const { flags, positionals } = parseArgs(argv)
    const command = positionals[0]
    if (!command || flags.help || command === 'help') {
      io.stdout.write(USAGE)
      return EXIT_CODES.OK
    }
    const ctx = {
      io,
      flags,
      positionals: positionals.slice(1),
      env,
      fetchImpl
    }

    switch (command) {
      case 'ingest':
        return await commandIngest(ctx)
      case 'lenses':
        return commandLenses(ctx)
      case 'slice':
        return commandSlice(ctx)
      case 'prompt':
        return commandPrompt(ctx)
      case 'validate-report':
        return commandValidateReport(ctx)
      case 'synthesize':
        return commandSynthesize(ctx)
      case 'render':
        return commandRender(ctx)
      case 'publish':
        return await commandPublish(ctx)
      case 'open-repo-pr':
        return await commandOpenRepoPr(ctx)
      case 'selftest':
        return commandSelftest(ctx)
      default:
        throw new ContractError(ERROR_CODES.INVALID_INPUT, `Unknown command: ${command}`, EXIT_CODES.VALIDATION)
    }
  } catch (error) {
    if (error instanceof ContractError) {
      io.stderr.write(`${formatJsonError(error.code, error.message)}\n`)
      return error.exitCode ?? EXIT_CODES.VALIDATION
    }
    io.stderr.write(`${formatJsonError(ERROR_CODES.INTERNAL, error?.message || String(error))}\n`)
    return EXIT_CODES.INTERNAL
  }
}