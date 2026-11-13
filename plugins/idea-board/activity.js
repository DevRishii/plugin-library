/**
 * Deterministic workspace-activity digest for the Dreamer.
 *
 * The Dreamer already receives recent sessions with their user messages. This
 * module adds what actually happened in those sessions: files changed with
 * their before/after hashes, commands that failed, open threads, models, and
 * cost — the Session Diff receipt, summarized and rolled up so recurrence is
 * visible at a glance.
 *
 * The engine is loaded from the sibling `session-diff` project when present;
 * otherwise the digest falls back to receipts already recorded under
 * `~/.dsh/receipts`. A session without a receipt is reported as unavailable
 * and never guessed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Maximum sessions carried into one digest. */
const MAX_SESSIONS = 6
/** Maximum per-session file rows. */
const MAX_FILES = 4
/** Maximum per-session failing commands. */
const MAX_COMMANDS = 2
/** Maximum per-session open threads. */
const MAX_THREADS = 2
/** Maximum recurring groups in the rollup. */
const MAX_RECURRING = 5
/** Skip a session log larger than this many bytes; the digest stays bounded. */
const MAX_LOG_BYTES = 25 * 1024 * 1024
/** Retention assumptions used only when building a receipt on demand. */
const RETENTION_DAYS = 7
const MAX_SNAPSHOT_BYTES = 500 * 1024 * 1024

/** One loaded engine surface, or null when the sibling project is absent. */
let enginePromise

/**
 * Load the Session Diff engine modules from the sibling project.
 * @returns {Promise<object | null>} the engine surface, or null.
 */
function loadEngine() {
  enginePromise ??= (async () => {
    try {
      const [session, receipt, snapshots] = await Promise.all([
        import('../session-diff/src/session.mjs'),
        import('../session-diff/src/receipt.mjs'),
        import('../session-diff/src/snapshots.mjs'),
      ])
      return {
        readSessionFile: session.readSessionFile,
        workspaceSlug: session.workspaceSlug,
        buildReceipt: receipt.buildReceipt,
        SnapshotStore: snapshots.SnapshotStore,
        sessionReceiptDir: snapshots.sessionReceiptDir,
      }
    } catch {
      return null
    }
  })()
  return enginePromise
}

/**
 * Encode a working directory the way the Harness names its session folder.
 * @param {string} cwd - absolute working directory.
 * @returns {string} the folder name.
 */
function slug(cwd) {
  const body = resolve(cwd).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `--${body}--`
}

/**
 * Read one stored receipt.
 * @param {string} dir - session receipt directory.
 * @returns {object | null} the receipt.
 */
function readStored(dir) {
  const file = join(dir, 'receipt.json')
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Load one session's receipt from the store, or build it from the session log.
 * @param {{id: string, cwd?: string}} session - one digest session.
 * @param {{home: string, projectCwd: string, engine: object | null}} options - store and engine context.
 * @returns {Promise<{receipt: object, source: 'stored'|'built'} | null>} the receipt.
 */
async function receiptFor(session, options) {
  const cwd = typeof session.cwd === 'string' && session.cwd !== '' ? session.cwd : options.projectCwd
  const { engine, home } = options
  const dir = engine === null
    ? join(home, '.dsh', 'receipts', slug(cwd), session.id)
    : engine.sessionReceiptDir(cwd, session.id, { home })
  const stored = readStored(dir)
  if (stored !== null) return { receipt: stored, source: 'stored' }
  if (engine === null) return null
  const log = join(home, '.dsh', 'sessions', engine.workspaceSlug(cwd), session.id, 'session.v4.jsonl.zstd')
  if (!existsSync(log)) return null
  try {
    if (statSync(log).size > MAX_LOG_BYTES) return null
    const events = engine.readSessionFile(log)
    const store = new engine.SnapshotStore({ dir, retentionDays: RETENTION_DAYS, maxBytes: MAX_SNAPSHOT_BYTES })
    const receipt = await engine.buildReceipt({ events, cwd, sessionId: session.id, store, home })
    return { receipt, source: 'built' }
  } catch {
    return null
  }
}

/**
 * Bound one string for model-visible output.
 * @param {unknown} value - candidate.
 * @param {number} max - maximum length.
 * @returns {string} the trimmed text.
 */
function text(value, max) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * Summarize one receipt for the digest.
 * @param {object} session - the digest session.
 * @param {{receipt: object, source: string}} loaded - the receipt and its origin.
 * @returns {object} the bounded summary.
 */
function summarize(session, loaded) {
  const receipt = loaded.receipt
  const files = Array.isArray(receipt.files) ? receipt.files : []
  const commands = Array.isArray(receipt.commands) ? receipt.commands : []
  const threads = Array.isArray(receipt.threads) ? receipt.threads : []
  const models = Array.isArray(receipt.models) ? receipt.models : []
  const failing = commands
    .filter(command => command?.exitCode !== 0)
    .slice(-MAX_COMMANDS)
    .map(command => ({
      command: text(command.command, 160),
      exitCode: typeof command.exitCode === 'number' ? command.exitCode : null,
      firstFailureLine: text(command.firstFailureLine, 160) || null,
    }))
  return {
    id: session.id,
    title: text(session.title, 120) || text(receipt.session?.title, 120) || '(untitled)',
    source: loaded.source,
    available: true,
    startedAt: typeof receipt.session?.startedAt === 'number' ? receipt.session.startedAt : null,
    endedAt: typeof receipt.session?.endedAt === 'number' ? receipt.session.endedAt : null,
    durationMs: typeof receipt.session?.durationMs === 'number' ? receipt.session.durationMs : null,
    files: {
      added: receipt.summary?.filesAdded ?? 0,
      modified: receipt.summary?.filesModified ?? 0,
      deleted: receipt.summary?.filesDeleted ?? 0,
    },
    commands: {
      total: receipt.summary?.commands ?? 0,
      failed: receipt.summary?.commandsFailed ?? 0,
    },
    openThreads: receipt.summary?.openThreads ?? threads.length,
    costUsd: typeof receipt.summary?.totalCostUsd === 'number' ? receipt.summary.totalCostUsd : null,
    models: [...new Set(models.map(model => text(model?.model, 60)).filter(Boolean))].slice(0, 4),
    topFiles: files.slice(0, MAX_FILES).map(file => ({
      path: text(file?.path, 160),
      status: file?.status === 'added' || file?.status === 'modified' || file?.status === 'deleted' ? file.status : 'modified',
    })),
    failingCommands: failing,
    topThreads: threads.slice(0, MAX_THREADS).map(thread => ({
      kind: text(thread?.kind, 40),
      title: text(thread?.title, 120),
      detail: text(thread?.detail, 160),
    })),
  }
}

/**
 * Build the recurrence rollup over available sessions.
 * @param {Array<object>} items - per-session summaries.
 * @returns {object} the rollup.
 */
function rollup(items) {
  const available = items.filter(item => item.available === true)
  const fileSessions = new Map()
  const failureSessions = new Map()
  const threadKeys = new Map()
  let added = 0
  let modified = 0
  let deleted = 0
  let commands = 0
  let failed = 0
  let openThreads = 0
  let costUsd = 0
  let pricedSessions = 0
  let from = null
  let to = null
  for (const item of available) {
    added += item.files.added
    modified += item.files.modified
    deleted += item.files.deleted
    commands += item.commands.total
    failed += item.commands.failed
    openThreads += item.openThreads
    if (typeof item.costUsd === 'number') {
      costUsd += item.costUsd
      pricedSessions += 1
    }
    if (item.startedAt !== null && (from === null || item.startedAt < from)) from = item.startedAt
    if (item.endedAt !== null && (to === null || item.endedAt > to)) to = item.endedAt
    for (const file of item.topFiles) {
      if (file.path === '') continue
      const entry = fileSessions.get(file.path) ?? { path: file.path, statuses: new Set(), sessions: new Set() }
      entry.statuses.add(file.status)
      entry.sessions.add(item.id)
      fileSessions.set(file.path, entry)
    }
    for (const failure of item.failingCommands) {
      if (failure.command === '') continue
      const entry = failureSessions.get(failure.command) ?? { command: failure.command, sessions: new Set(), lastFailure: null }
      entry.sessions.add(item.id)
      if (failure.firstFailureLine !== null) entry.lastFailure = failure.firstFailureLine
      failureSessions.set(failure.command, entry)
    }
    for (const thread of item.topThreads) {
      if (thread.detail === '' && thread.title === '') continue
      // Recurrence is a pattern, not an identical line: group by kind and title
      // and keep the most recent detail as the example.
      const key = `${thread.kind}\u0000${thread.title}`
      const entry = threadKeys.get(key) ?? { kind: thread.kind, title: thread.title, detail: thread.detail, sessions: new Set() }
      entry.sessions.add(item.id)
      if (thread.detail !== '') entry.detail = thread.detail
      threadKeys.set(key, entry)
    }
  }
  const recurringFiles = [...fileSessions.values()]
    .filter(entry => entry.sessions.size >= 2)
    .sort((left, right) => right.sessions.size - left.sessions.size || left.path.localeCompare(right.path))
    .slice(0, MAX_RECURRING)
    .map(entry => ({ path: entry.path, sessions: entry.sessions.size, statuses: [...entry.statuses].sort() }))
  const recurringFailures = [...failureSessions.values()]
    .filter(entry => entry.sessions.size >= 2)
    .sort((left, right) => right.sessions.size - left.sessions.size || left.command.localeCompare(right.command))
    .slice(0, MAX_RECURRING)
    .map(entry => ({ command: entry.command, sessions: entry.sessions.size, lastFailure: entry.lastFailure }))
  const openThreadRepeats = [...threadKeys.values()]
    .filter(entry => entry.sessions.size >= 2)
    .sort((left, right) => right.sessions.size - left.sessions.size || left.detail.localeCompare(right.detail))
    .slice(0, MAX_RECURRING)
    .map(entry => ({ kind: entry.kind, title: entry.title, detail: entry.detail, sessions: entry.sessions.size }))
  return {
    sessions: available.length,
    unavailable: items.length - available.length,
    window: { from, to },
    files: { added, modified, deleted },
    commands: { total: commands, failed },
    openThreads,
    costUsd: pricedSessions === 0 ? null : Math.round(costUsd * 1e6) / 1e6,
    recurringFiles,
    recurringFailures,
    openThreadRepeats,
  }
}

/**
 * Build the workspace-activity digest for the Dreamer.
 * @param {Array<{id: string, title?: string, cwd?: string}>} sessions - recent non-subagent sessions.
 * @param {{home?: string, projectCwd?: string, now?: number, excludeId?: string}} [options] - store overrides.
 * @returns {Promise<object>} `{sessions, rollup, generatedAt}`; never throws.
 */
export async function activityDigest(sessions, options = {}) {
  const home = typeof options.home === 'string' && options.home !== '' ? options.home : homedir()
  const projectCwd = typeof options.projectCwd === 'string' && options.projectCwd !== '' ? options.projectCwd : process.cwd()
  const engine = await loadEngine()
  const limit = Array.isArray(sessions) ? sessions.slice(0, MAX_SESSIONS) : []
  const items = []
  for (const session of limit) {
    if (session === null || typeof session !== 'object' || typeof session.id !== 'string') continue
    if (options.excludeId !== undefined && session.id === options.excludeId) continue
    try {
      const loaded = await receiptFor(session, { home, projectCwd, engine })
      if (loaded === null) {
        items.push({ id: session.id, title: text(session.title, 120) || '(untitled)', available: false, reason: 'no receipt and no readable session log' })
        continue
      }
      items.push(summarize(session, loaded))
    } catch {
      items.push({ id: session.id, title: text(session.title, 120) || '(untitled)', available: false, reason: 'receipt unavailable' })
    }
  }
  return {
    sessions: items,
    rollup: rollup(items),
    generatedAt: typeof options.now === 'number' ? options.now : Date.now(),
  }
}
