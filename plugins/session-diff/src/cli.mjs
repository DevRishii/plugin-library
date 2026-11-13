/**
 * `dsh-receipt` command line: print, compare, export, list, restore, and
 * collect receipts without booting the Harness.
 *
 * The CLI reads the durable session log, the workspace's current file state,
 * and (when present) the pre-write snapshot store. It is read-only except for
 * `restore` and `gc`.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { buildReceipt, readStoredReceipt } from './receipt.mjs'
import { compareReceipts } from './diff.mjs'
import { renderHtml, renderJson, renderMarkdown } from './render.mjs'
import { SnapshotStore, sessionReceiptDir } from './snapshots.mjs'
import { absolutePath } from './paths.mjs'
import { listSessions, readSessionFile, readSessionHeader, resolveSession } from './session.mjs'
import { formatUsd } from './pricing.mjs'

/** Usage text for help and usage errors. */
export const USAGE = `Usage: dsh-receipt <command> [options]

Commands:
  print [session]              Print one receipt (default: the latest session in --cwd)
  compare <session-a> <session-b>  Compare two receipts
  export [session]             Export a receipt
  list                         List the working directory's sessions and receipts
  restore <session> <path>     Restore one file from its pre-write snapshot
  gc                           Drop snapshots past the retention bounds

Options:
  --cwd <dir>        Working directory to resolve sessions from (default: current)
  --home <dir>       Home directory holding .dsh (default: the real home)
  --json             Machine-readable output for print, compare, and list
  --rebuild          Rebuild the receipt from the session log instead of reading the stored one
  --format <fmt>     Export format: markdown (default), json, html
  --out <file>       Write the export to a file instead of stdout
  --force            Restore even when the file changed after the receipt
  --include-all      Do not drop node_modules and .git
  --days <n>         Retention days for gc (default: 7)
  --max-mb <n>       Retention cap in MB for gc (default: 500)`

/**
 * Parse argv into a command and options.
 * @param {string[]} argv - arguments after the program name.
 * @returns {{command: string, positionals: string[], options: object}} parsed invocation.
 */
export function parseArgv(argv) {
  const options = {
    cwd: process.cwd(), home: homedir(), json: false, rebuild: false, force: false,
    includeAll: false, format: 'markdown', out: null, days: null, maxMb: null,
  }
  const positionals = []
  let command = null
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') return { command: 'help', positionals, options }
    if (token === '--json') { options.json = true; continue }
    if (token === '--rebuild') { options.rebuild = true; continue }
    if (token === '--force') { options.force = true; continue }
    if (token === '--include-all') { options.includeAll = true; continue }
    const value = (name) => {
      const next = argv[index + 1]
      if (next === undefined) throw new Error(`${name} needs a value\n\n${USAGE}`)
      index += 1
      return next
    }
    if (token === '--cwd') { options.cwd = resolve(value('--cwd')); continue }
    if (token === '--home') { options.home = resolve(value('--home')); continue }
    if (token === '--format') { options.format = value('--format').toLowerCase(); continue }
    if (token === '--out') { options.out = resolve(value('--out')); continue }
    if (token === '--days') { options.days = Number(value('--days')); continue }
    if (token === '--max-mb') { options.maxMb = Number(value('--max-mb')); continue }
    if (token.startsWith('--')) throw new Error(`unknown option ${token}\n\n${USAGE}`)
    if (command === null) command = token
    else positionals.push(token)
  }
  if (command === null) command = 'print'
  return { command, positionals, options }
}

/**
 * Resolve a session selector to its receipt directory and stored receipt.
 * @param {string} selector - session id, `latest`, or a log path.
 * @param {object} options - parsed options.
 * @returns {{id: string, file: string, cwd: string, dir: string}} session coordinates.
 */
function sessionCoordinates(selector, options) {
  const resolved = resolveSession(selector, { cwd: options.cwd, home: options.home })
  const header = readSessionHeader(resolved.file) ?? {}
  const cwd = typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : options.cwd
  return { id: resolved.id, file: resolved.file, cwd, dir: sessionReceiptDir(cwd, resolved.id, { home: options.home }) }
}

/**
 * Load one receipt: the stored record unless `--rebuild` asks for a re-derivation.
 * @param {string} selector - session selector.
 * @param {object} options - parsed options.
 * @returns {Promise<{receipt: object, source: string, dir: string}>} the receipt and its origin.
 */
export async function loadReceipt(selector, options) {
  const coordinates = sessionCoordinates(selector, options)
  if (!options.rebuild) {
    const stored = readStoredReceipt(coordinates.dir)
    if (stored !== null) return { receipt: stored, source: 'stored', dir: coordinates.dir }
  }
  const events = readSessionFile(coordinates.file)
  const store = new SnapshotStore({
    dir: coordinates.dir,
    retentionDays: options.days ?? 7,
    maxBytes: (options.maxMb ?? 500) * 1024 * 1024,
  })
  const receipt = await buildReceipt({
    events,
    cwd: coordinates.cwd,
    sessionId: coordinates.id,
    store,
    home: options.home,
    generatedAt: Date.now(),
    excludes: options.includeAll ? [] : undefined,
  })
  return { receipt, source: 'built', dir: coordinates.dir }
}

/**
 * Concise human lines for one receipt.
 * @param {object} receipt - the receipt.
 * @returns {string[]} display lines.
 */
export function summaryLines(receipt) {
  const { summary, session } = receipt
  const lines = [
    `Session ${session.id}${session.title === null ? '' : ` — ${session.title}`}`,
    `Cwd: ${session.cwd}`,
    `Span: ${isoOrUnknown(session.startedAt)} → ${isoOrUnknown(session.endedAt)}${session.durationMs === null ? '' : ` (${formatDuration(session.durationMs)})`}`,
    `Turns: ${summary.turns} · Steps: ${summary.steps} · Tool calls: ${summary.toolCalls} · Events: ${session.eventCount}`,
    `Files: ${summary.filesAdded} added, ${summary.filesModified} modified, ${summary.filesDeleted} deleted`,
    `Commands: ${summary.commands} run, ${summary.commandsFailed} failed`,
    `Models: ${summary.models === 0 ? 'none recorded' : receipt.models.map(model => `${model.model} (${model.requests} req, ${formatUsd(model.costUsd)})`).join(', ')}`,
    `Cost: ${formatUsd(summary.totalCostUsd)}${summary.unpricedModels.length === 0 ? '' : ` (unpriced: ${summary.unpricedModels.join(', ')})`}`,
    `Open threads: ${summary.openThreads}`,
  ]
  for (const thread of receipt.threads.slice(0, 12)) {
    lines.push(`  [${thread.kind}] ${thread.detail}${thread.ref === undefined ? '' : ` (seq ${thread.ref})`}`)
  }
  if (receipt.snapshots !== null && receipt.snapshots !== undefined) {
    lines.push(`Snapshots: ${receipt.snapshots.entries} for ${receipt.snapshots.paths} path${receipt.snapshots.paths === 1 ? '' : 's'} (${formatBytes(receipt.snapshots.bytes)}; retention ${receipt.snapshots.retentionDays}d / ${formatBytes(receipt.snapshots.maxBytes)})`)
  }
  return lines
}

/**
 * Run one CLI invocation.
 * @param {string[]} argv - arguments after the program name.
 * @param {{stdout: (text: string) => void, stderr: (text: string) => void, cwd?: string, home?: string}} io - output sinks.
 * @returns {Promise<number>} process exit code.
 */
export async function run(argv, io) {
  const out = io.stdout
  const fail = io.stderr
  let parsed
  try {
    parsed = parseArgv(argv)
  } catch (error) {
    fail(`${messageOf(error)}\n`)
    return 2
  }
  if (io.cwd !== undefined) parsed.options.cwd = io.cwd
  if (io.home !== undefined) parsed.options.home = io.home
  const { command, positionals, options } = parsed
  try {
    if (command === 'help') {
      out(`${USAGE}\n`)
      return 0
    }
    if (command === 'print') {
      const selector = positionals[0] ?? 'latest'
      const { receipt, source } = await loadReceipt(selector, options)
      if (options.json) out(`${JSON.stringify(receipt, null, 2)}\n`)
      else {
        out(`${summaryLines(receipt).join('\n')}\n`)
        if (receipt.files.length > 0) {
          out(`\nFiles:\n${receipt.files.map(file => `  ${statusGlyph(file.status)} ${file.path}  ${hashPair(file)}`).join('\n')}\n`)
        }
        if (source === 'stored') out(`\n(stored receipt; --rebuild re-derives it from the session log)\n`)
      }
      return 0
    }
    if (command === 'compare') {
      const leftSelector = positionals[0]
      const rightSelector = positionals[1]
      if (leftSelector === undefined || rightSelector === undefined) {
        fail(`compare needs two sessions\n\n${USAGE}\n`)
        return 2
      }
      const [left, right] = await Promise.all([loadReceipt(leftSelector, options), loadReceipt(rightSelector, options)])
      const result = compareReceipts(left.receipt, right.receipt)
      if (options.json) out(`${JSON.stringify(result, null, 2)}\n`)
      else out(renderComparison(result))
      return 0
    }
    if (command === 'export') {
      const selector = positionals[0] ?? 'latest'
      const { receipt } = await loadReceipt(selector, options)
      const format = options.format
      const body = format === 'json' ? renderJson(receipt) : format === 'html' ? renderHtml(receipt) : renderMarkdown(receipt)
      if (options.out === null) {
        out(body.endsWith('\n') ? body : `${body}\n`)
      } else {
        mkdirSync(dirname(options.out), { recursive: true })
        writeFileSync(options.out, body, 'utf8')
        out(`Wrote ${options.out}\n`)
      }
      return 0
    }
    if (command === 'list') {
      const sessions = listSessions(options.cwd, { home: options.home })
      const rows = sessions.map((session) => {
        const dir = sessionReceiptDir(options.cwd, session.id, { home: options.home })
        const receipt = readStoredReceipt(dir)
        return {
          id: session.id,
          updatedAt: new Date(session.mtimeMs).toISOString(),
          bytes: session.size,
          receipt: receipt === null ? null : {
            generatedAt: receipt.generatedAt,
            files: receipt.summary.filesAdded + receipt.summary.filesModified + receipt.summary.filesDeleted,
            commands: receipt.summary.commands,
            costUsd: receipt.summary.totalCostUsd,
            openThreads: receipt.summary.openThreads,
          },
        }
      })
      if (options.json) out(`${JSON.stringify({ cwd: options.cwd, sessions: rows }, null, 2)}\n`)
      else {
        out(`Sessions for ${options.cwd}\n`)
        if (rows.length === 0) out('  (none)\n')
        for (const row of rows) {
          out(`  ${row.id}  ${row.updatedAt}  ${row.receipt === null ? 'no receipt' : `${row.receipt.files} files, ${row.receipt.commands} commands, ${formatUsd(row.receipt.costUsd)}, ${row.receipt.openThreads} threads`}\n`)
        }
      }
      return 0
    }
    if (command === 'restore') {
      const selector = positionals[0]
      const path = positionals[1]
      if (selector === undefined || path === undefined) {
        fail(`restore needs a session and a receipt-relative path\n\n${USAGE}\n`)
        return 2
      }
      const { receipt, dir } = await loadReceipt(selector, options)
      const row = receipt.files.find(file => file.path === normalizeReceiptPath(path))
      if (row === undefined) {
        fail(`${path} is not a file in the receipt for ${receipt.session.id}\n`)
        return 1
      }
      if (row.beforeSource !== 'snapshot') {
        fail(`no snapshot backs ${row.path}; its before state is ${row.beforeSource === 'absent' ? 'absent (the session created the file)' : 'unavailable'}\n`)
        return 1
      }
      const store = new SnapshotStore({ dir, retentionDays: options.days ?? 7, maxBytes: (options.maxMb ?? 500) * 1024 * 1024 })
      const result = await store.restore({
        path: row.path,
        absolute: absolutePath(receipt.session.cwd, row.path),
        expectedAfterHash: row.afterSha256,
        force: options.force,
      })
      if (!result.ok) {
        fail(`${result.reason}\n`)
        return 1
      }
      out(`Restored ${row.path} (${result.restoredBytes} bytes, sha256 ${result.restoredHash})\n`)
      return 0
    }
    if (command === 'gc') {
      const sessions = listSessions(options.cwd, { home: options.home })
      let entries = 0
      for (const session of sessions) {
        const dir = sessionReceiptDir(options.cwd, session.id, { home: options.home })
        if (!existsSync(dir)) continue
        const store = new SnapshotStore({
          dir,
          retentionDays: options.days ?? 7,
          maxBytes: (options.maxMb ?? 500) * 1024 * 1024,
        })
        const result = await store.gc()
        entries += result.removedEntries
        if (result.removedEntries > 0 || result.removedObjects > 0) {
          out(`${session.id}: removed ${result.removedEntries} entries, ${result.removedObjects} objects (${formatBytes(result.freedBytes)})\n`)
        }
      }
      if (entries === 0) out('Nothing to collect.\n')
      return 0
    }
    if (command === 'capture') {
      fail('capture is recorded by the Host plugin before each file write; it is not a CLI command.\n')
      return 2
    }
    fail(`unknown command ${command}\n\n${USAGE}\n`)
    return 2
  } catch (error) {
    fail(`${messageOf(error)}\n`)
    return 1
  }
}

/**
 * Render a comparison for humans.
 * @param {object} result - `compareReceipts` output.
 * @returns {string} display text.
 */
export function renderComparison(result) {
  const lines = [
    `Receipt comparison`,
    `  from: ${result.from.sessionId} (${isoOrUnknown(result.from.generatedAt)})`,
    `  to:   ${result.to.sessionId} (${isoOrUnknown(result.to.generatedAt)})`,
    `  identical: ${result.identical ? 'yes' : 'no'}`,
    `Files: +${result.files.added.length} -${result.files.removed.length} ~${result.files.changed.length}`,
    ...result.files.added.map(path => `  added    ${path}`),
    ...result.files.removed.map(path => `  removed  ${path}`),
    ...result.files.changed.map(file => `  changed  ${file.path} (${file.fromStatus} → ${file.toStatus})`),
    `Commands: ${result.commands.before} → ${result.commands.after} (delta ${signed(result.commands.delta)}), failed ${result.commands.beforeFailed} → ${result.commands.afterFailed}`,
    `Cost: ${formatUsd(result.cost.before)} → ${formatUsd(result.cost.after)} (delta ${result.cost.delta === null ? 'unknown' : formatUsd(result.cost.delta)})`,
    ...result.cost.byModel.map(model => `  ${model.model}: ${formatUsd(model.before)} → ${formatUsd(model.after)}`),
    `Models: +${result.models.added.length} -${result.models.removed.length}`,
    `Threads: resolved ${result.threads.resolved.length}, opened ${result.threads.opened.length}, persisted ${result.threads.persisted.length}`,
    ...result.threads.resolved.map(thread => `  resolved  [${thread.kind}] ${thread.detail}`),
    ...result.threads.opened.map(thread => `  opened    [${thread.kind}] ${thread.detail}`),
  ]
  return `${lines.join('\n')}\n`
}

/**
 * Normalize a user-supplied receipt path.
 * @param {string} value - path with either separator.
 * @returns {string} slash-separated path.
 */
export function normalizeReceiptPath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * Status glyph for the file list.
 * @param {string} status - added, modified, or deleted.
 * @returns {string} one character.
 */
function statusGlyph(status) {
  if (status === 'added') return 'A'
  if (status === 'deleted') return 'D'
  return 'M'
}

/**
 * Short before/after hash pair.
 * @param {object} file - receipt file row.
 * @returns {string} display text.
 */
function hashPair(file) {
  const short = value => value === null ? (file.status === 'added' ? 'absent' : 'unknown') : `${value.slice(0, 12)}…`
  const after = file.status === 'deleted' && file.afterSha256 === null ? 'deleted' : short(file.afterSha256)
  return `${short(file.beforeSha256)} → ${after}`
}

/**
 * Format a byte count.
 * @param {number} bytes - bytes.
 * @returns {string} human text.
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Format a duration.
 * @param {number} ms - milliseconds.
 * @returns {string} human text.
 */
function formatDuration(ms) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * ISO text or "unknown".
 * @param {number|null} epochMs - timestamp.
 * @returns {string} display text.
 */
function isoOrUnknown(epochMs) {
  return typeof epochMs === 'number' ? new Date(epochMs).toISOString() : 'unknown'
}

/**
 * Signed number text.
 * @param {number} value - number.
 * @returns {string} text with an explicit sign.
 */
function signed(value) {
  return value > 0 ? `+${value}` : String(value)
}

/**
 * A concise error message.
 * @param {unknown} error - thrown value.
 * @returns {string} message text.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
