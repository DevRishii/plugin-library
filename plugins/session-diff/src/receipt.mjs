/**
 * Receipt assembly: join the Session's extracted facts with the workspace's
 * current file state and the pre-write snapshot store.
 *
 * The receipt is deterministic for one session plus one workspace state. It
 * never summarizes the transcript with a model: every line is backed by an
 * event sequence number or a file hash.
 */
import { existsSync, readFileSync } from 'node:fs'
import { extractFacts } from './facts.mjs'
import { DEFAULT_EXCLUDES, comparePaths, displayPath, fileBytes, isExcluded, isFile, sha256, sha256File } from './paths.mjs'
import { sessionHeader, sessionTitle } from './session.mjs'

/** Receipt schema version. */
export const RECEIPT_VERSION = 1

/**
 * Apply a session's file operations to a starting content.
 * @param {Array<object>} ops - ordered file operations.
 * @param {string} start - starting text.
 * @returns {string | null} the final text, or null when an edit cannot be applied.
 */
export function replayOps(ops, start) {
  let current = start
  for (const op of ops) {
    if (op.operation === 'create' || op.operation === 'update') {
      if (typeof op.content !== 'string') return null
      current = op.content
      continue
    }
    if (op.operation === 'edit') {
      if (typeof op.oldString !== 'string' || typeof op.newString !== 'string') return null
      if (op.replaceAll === true) {
        if (!current.includes(op.newString)) return null
        current = current.split(op.newString).join(op.oldString)
      } else {
        const at = current.indexOf(op.oldString)
        if (at < 0) return null
        if (current.indexOf(op.oldString, at + 1) >= 0) return null
        current = current.slice(0, at) + op.newString + current.slice(at + op.oldString.length)
      }
      continue
    }
    return null
  }
  return current
}

/**
 * Recover the state before the session's first mutation by reversing its edits
 * from the current file and verifying the replay closes.
 * @param {Array<object>} ops - ordered file operations, none of them a create.
 * @param {string} finalText - current on-disk text.
 * @returns {{sha256: string, bytes: number} | null} the derived before state.
 */
export function deriveBefore(ops, finalText) {
  if (ops.length === 0) return null
  // A whole-file write makes the earlier state unknowable: replaying backwards
  // can reach the write's own content but never the state it replaced.
  if (ops.some(op => op.operation !== 'edit')) return null
  let current = finalText
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    const op = ops[index]
    if (typeof op.oldString !== 'string' || typeof op.newString !== 'string') return null
    if (op.replaceAll === true) {
      if (!current.includes(op.newString)) return null
      current = current.split(op.newString).join(op.oldString)
    } else {
      const first = current.indexOf(op.newString)
      if (first < 0) return null
      if (current.lastIndexOf(op.newString) !== first) return null
      current = current.slice(0, first) + op.oldString + current.slice(first + op.newString.length)
    }
  }
  const replayed = replayOps(ops, current)
  if (replayed === null || replayed !== finalText) return null
  return { sha256: sha256(current), bytes: Buffer.byteLength(current) }
}

/**
 * Classify one file's session history.
 * @param {object} file - one file's extracted operations.
 * @param {{cwd: string, store: object|null, excludes: readonly string[], home?: string}} context - workspace and snapshot store.
 * @returns {Promise<object | null>} the receipt file row, or null when excluded.
 */
async function fileRow(file, context) {
  const display = file.path
  if (isExcluded(display, context.excludes)) return null
  const diskFile = file.absolute
  const exists = isFile(diskFile)
  const ops = file.ops
  const first = ops[0]
  const last = ops.at(-1)
  const deleted = !exists
  const status = deleted ? 'deleted' : first?.operation === 'create' ? 'added' : 'modified'

  let beforeSha256 = null
  let beforeBytes = null
  let beforeSource = 'unavailable'
  const capture = context.store?.before(display) ?? null
  if (capture !== null) {
    beforeSha256 = capture.hash
    beforeBytes = capture.bytes
    beforeSource = 'snapshot'
  } else if (first?.operation === 'create') {
    beforeSource = 'absent'
  } else if (exists) {
    const derived = deriveBefore(ops, readFileSync(diskFile, 'utf8'))
    if (derived !== null) {
      beforeSha256 = derived.sha256
      beforeBytes = derived.bytes
      beforeSource = 'derived'
    }
  }

  let afterSha256 = null
  let afterBytes = null
  let afterSource = exists ? 'disk' : 'absent'
  if (exists) {
    afterSha256 = await sha256File(diskFile)
    afterBytes = fileBytes(diskFile)
  }

  return {
    path: display,
    status,
    beforeSha256,
    afterSha256,
    beforeBytes,
    afterBytes,
    beforeSource,
    afterSource,
    ops: ops.map(op => ({
      seq: op.seq,
      turn: op.turn,
      tool: op.tool,
      operation: op.operation,
      ok: op.ok,
    })),
  }
}

/**
 * Build the deterministic open-threads list.
 * @param {object} facts - extracted facts.
 * @returns {Array<object>} open threads in a stable order.
 */
export function buildThreads(facts) {
  const threads = []
  const byCommand = new Map()
  for (const command of facts.commands) byCommand.set(command.command, command)
  const failing = [...byCommand.values()].filter(command => command.exitCode !== 0).sort((left, right) => right.seq - left.seq)
  if (failing.length > 0) {
    const last = failing[0]
    threads.push({
      kind: 'failing-command',
      title: 'Last command still failing',
      detail: last.firstFailureLine ?? (last.exitCode === null ? 'the command never reported an exit code' : `exit code ${last.exitCode}`),
      command: last.command,
      exitCode: last.exitCode,
      ref: last.seq,
    })
  }
  const failedTests = facts.commands.filter(command => command.failedTests).sort((left, right) => right.seq - left.seq).slice(0, 10)
  for (const command of failedTests) {
    threads.push({
      kind: 'failed-tests',
      title: 'Test run failed',
      detail: command.failureSummary ?? command.firstFailureLine ?? 'test command reported failure',
      command: command.command,
      exitCode: command.exitCode,
      ref: command.seq,
    })
  }
  for (const turn of facts.turns) {
    if (turn.reason !== null && turn.reason !== 'completed') {
      threads.push({
        kind: 'unfinished-turn',
        title: `Turn ${turn.turn} ended with ${turn.reason}`,
        detail: 'The turn did not complete; review its last step.',
        ref: turn.endedAt,
        turn: turn.turn,
      })
    }
  }
  const lastTodos = facts.todoWrites.at(-1)
  if (lastTodos !== undefined) {
    for (const todo of lastTodos.todos) {
      if (todo?.status === 'completed') continue
      threads.push({ kind: 'todo', title: 'Checklist item open', detail: String(todo?.content ?? ''), ref: lastTodos.seq })
    }
  }
  for (const marker of facts.todoMarkers) {
    threads.push({
      kind: 'todo-marker',
      title: `${marker.kind} written to ${marker.path}:${marker.line}`,
      detail: marker.text,
      path: marker.path,
      ref: marker.seq,
    })
  }
  return threads
}

/**
 * Build one session's receipt.
 * @param {{events: Array<object>, cwd: string, sessionId?: string, store?: object|null, generatedAt?: number, excludes?: readonly string[], home?: string}} input - session log and workspace context.
 * @returns {Promise<object>} the receipt.
 */
export async function buildReceipt(input) {
  const excludes = input.excludes ?? DEFAULT_EXCLUDES
  const facts = extractFacts(input.events, { cwd: input.cwd, home: input.home })
  const header = sessionHeader(input.events)
  const files = []
  for (const file of facts.files) {
    const row = await fileRow(file, { cwd: input.cwd, store: input.store ?? null, excludes, home: input.home })
    if (row !== null) files.push(row)
  }
  files.sort((left, right) => comparePaths(left.path, right.path))
  const threads = buildThreads(facts)
  const totalCost = facts.models.reduce((sum, model) => sum + model.costUsd, 0)
  const unpriced = facts.models.filter(model => model.unpricedRequests > 0).map(model => model.model)
  const counts = {
    added: files.filter(file => file.status === 'added').length,
    modified: files.filter(file => file.status === 'modified').length,
    deleted: files.filter(file => file.status === 'deleted').length,
  }

  return {
    version: RECEIPT_VERSION,
    kind: 'session-receipt',
    generator: { name: 'session-diff', version: '1.0.0' },
    generatedAt: input.generatedAt ?? Date.now(),
    session: {
      id: header.id ?? input.sessionId ?? 'unknown',
      title: sessionTitle(input.events),
      cwd: input.cwd,
      createdAt: header.createdAt ?? null,
      agentPreset: header.agentPreset ?? null,
      delegationDepth: header.delegationDepth ?? 0,
      startedAt: facts.firstEventAt,
      endedAt: facts.lastEventAt,
      durationMs: facts.firstEventAt !== null && facts.lastEventAt !== null ? facts.lastEventAt - facts.firstEventAt : null,
      eventCount: input.events.length,
      firstSeq: input.events[0]?.seq ?? null,
      lastSeq: input.events.at(-1)?.seq ?? null,
    },
    summary: {
      turns: facts.turns.length,
      steps: facts.steps,
      toolCalls: facts.toolCalls,
      filesAdded: counts.added,
      filesModified: counts.modified,
      filesDeleted: counts.deleted,
      commands: facts.commands.length,
      commandsFailed: facts.commands.filter(command => command.exitCode !== 0).length,
      models: facts.models.length,
      totalCostUsd: Math.round(totalCost * 1e6) / 1e6,
      unpricedModels: unpriced,
      openThreads: threads.length,
    },
    files,
    commands: facts.commands.map(command => ({
      seq: command.seq,
      turn: command.turn,
      time: command.time,
      tool: command.tool,
      command: command.command,
      exitCode: command.exitCode,
      ok: command.ok,
      firstFailureLine: command.firstFailureLine,
      failedTests: command.failedTests,
    })),
    models: facts.models.map(model => ({
      provider: model.provider,
      model: model.model,
      requests: model.requests,
      usage: model.usage,
      costUsd: model.costUsd,
      unpricedRequests: model.unpricedRequests,
    })),
    turns: facts.turns,
    modelSwitches: facts.switches.map(route => ({ seq: route.seq, turn: route.turn, provider: route.provider, model: route.model })),
    plugins: facts.plugins,
    settings: facts.settings,
    threads,
    snapshots: input.store === undefined || input.store === null
      ? null
      : { ...input.store.stats(), dir: input.store.dir },
  }
}

/**
 * The receipt's on-disk path in a session receipt directory.
 * @param {string} dir - session receipt directory.
 * @returns {string} `receipt.json` path.
 */
export function receiptFile(dir) {
  return `${dir}/receipt.json`
}

/**
 * Whether a receipt file exists.
 * @param {string} dir - session receipt directory.
 * @returns {boolean} existence.
 */
export function hasReceipt(dir) {
  return existsSync(receiptFile(dir))
}

/**
 * Read a stored receipt.
 * @param {string} dir - session receipt directory.
 * @returns {object | null} the receipt, or null when absent.
 */
export function readStoredReceipt(dir) {
  if (!hasReceipt(dir)) return null
  return JSON.parse(readFileSync(receiptFile(dir), 'utf8'))
}

/**
 * Display path for a file row, for callers holding absolute paths.
 * @param {string} cwd - working directory.
 * @param {string} absolute - absolute path.
 * @param {string} [home] - home override.
 * @returns {string} the display path.
 */
export function rowPath(cwd, absolute, home) {
  return displayPath(cwd, absolute, home)
}
