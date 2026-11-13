/**
 * Host half of Session Diff.
 *
 * It does three things, all on documented extension points:
 * 1. Captures a file's bytes immediately before a file tool mutates it, into a
 *    content-addressed snapshot store with retention (default 7 days / 500 MB).
 * 2. Records one receipt per session from the session event stream at every
 *    turn end, plus a rendered Markdown copy, under `~/.dsh/receipts`.
 * 3. Serves `receipt`, `export`, and `restore` to the client panel, the
 *    `/receipt` chat command, and a `receipt` tool.
 *
 * Nothing here writes a new session event: receipts are derived from existing
 * `tool/call`, `tool/result`, `assistant/message`, `turn/end`, and
 * `todo/write` events.
 */
import { mkdirSync, existsSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildReceipt, readStoredReceipt, receiptFile } from './src/receipt.mjs'
import { renderHtml, renderMarkdown } from './src/render.mjs'
import { SnapshotStore, receiptsRoot, sessionReceiptDir } from './src/snapshots.mjs'
import { displayPath, absolutePath } from './src/paths.mjs'
import { resolveSession, readSessionFile, readSessionHeader } from './src/session.mjs'

/** Stable Loader identity. */
export const name = 'session-diff'

/** The filesystem service resolves mutation targets for the capture hooks. */
export const inject = ['fs']

/**
 * Normalize plugin config, ignoring unknown keys.
 * @param {object | undefined} config - Loader-supplied config.
 * @returns {{snapshots: boolean, retentionDays: number, maxBytes: number, recordOnTurnEnd: boolean}} effective config.
 */
function effectiveConfig(config) {
  const source = config ?? {}
  const snapshots = source.snapshots ?? {}
  return {
    snapshots: snapshots.enabled !== false && source.snapshots !== false,
    retentionDays: Math.max(1, Math.floor(snapshots.retentionDays ?? source.retentionDays ?? 7)),
    maxBytes: Math.max(1024 * 1024, Math.floor(snapshots.maxBytes ?? source.maxBytes ?? 500 * 1024 * 1024)),
    maxFileBytes: Math.max(1024, Math.floor(snapshots.maxFileBytes ?? source.maxFileBytes ?? 2 * 1024 * 1024)),
    recordOnTurnEnd: source.recordOnTurnEnd !== false,
    home: typeof source.home === 'string' && source.home !== '' ? source.home : homedir(),
  }
}

/**
 * Register pre-write capture, automatic recording, routes, the tool, and the command.
 * @param {object} ctx - host context with `fs`, `webServer`, `commands`, and `tools`.
 * @param {object} [config] - validated bounds.
 */
export function apply(ctx, config) {
  const settings = effectiveConfig(config)
  const home = settings.home
  /** Per-session live state: cwd, buffered events, and the snapshot store. */
  const sessions = new Map()
  /** The session owning one in-flight tool execution, for the fs intent hooks. */
  const executions = new WeakMap()
  /** Serialized recording per session. */
  const recording = new Map()

  const stateFor = (session) => {
    const id = session?.id
    const cwd = session?.header?.cwd
    if (typeof id !== 'string' || typeof cwd !== 'string' || cwd === '') return null
    let state = sessions.get(id)
    if (state === undefined) {
      state = {
        id,
        cwd,
        events: [],
        turn: null,
        store: settings.snapshots
          ? new SnapshotStore({ dir: sessionReceiptDir(cwd, id, { home }), retentionDays: settings.retentionDays, maxBytes: settings.maxBytes, maxFileBytes: settings.maxFileBytes })
          : null,
        lastWrite: Promise.resolve(),
        timer: null,
      }
      sessions.set(id, state)
    }
    return state
  }

  /**
   * Prefix a session's buffered events with the durable log already on disk, so
   * a plugin installed mid-session still records the whole session.
   * @param {object} state - the session's live state.
   * @param {object} event - the first event this plugin instance sees.
   */
  const seed = (state, event) => {
    if (state.events.length > 0 || typeof event.seq !== 'number') return
    const log = findSessionLog(state.id, home)
    if (log === null) return
    try {
      const persisted = readSessionFile(log.file).filter(entry => typeof entry.seq === 'number' && entry.seq < event.seq)
      state.events.push(...persisted)
    } catch (error) {
      ctx.logger?.warn?.(`session-diff: could not seed ${state.id} from its log: ${String(error)}`)
    }
  }

  const record = (state) => {
    const previous = state.lastWrite
    const next = previous.then(async () => {
      const receipt = await buildReceipt({ events: state.events, cwd: state.cwd, sessionId: state.id, store: state.store, home })
      const dir = sessionReceiptDir(state.cwd, state.id, { home })
      mkdirSync(dir, { recursive: true })
      writeAtomic(receiptFile(dir), `${JSON.stringify(receipt, null, 2)}\n`)
      writeAtomic(join(dir, 'receipt.md'), renderMarkdown(receipt))
      state.receipt = receipt
    }).catch((error) => {
      ctx.logger?.warn?.(`session-diff: receipt for ${state.id} failed: ${String(error)}`)
    })
    state.lastWrite = next
    return next
  }

  ctx.on('session/event', (session, event) => {
    const state = stateFor(session)
    if (state === null) return
    seed(state, event)
    state.events.push(event)
    if (event.type === 'turn/start') state.turn = event.data?.turn ?? state.turn
    if (settings.recordOnTurnEnd && event.type === 'turn/end') {
      if (state.timer !== null) clearTimeout(state.timer)
      state.timer = setTimeout(() => {
        state.timer = null
        void record(state)
      }, 300)
    }
  })

  ctx.on('session/disposed', (session) => {
    const state = sessions.get(session?.id)
    if (state === undefined) return
    if (state.timer !== null) clearTimeout(state.timer)
    const pending = state.events.length > 0 ? record(state) : Promise.resolve()
    void pending.finally(() => { sessions.delete(state.id) })
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const session = exec?.agent?.session
    if (session !== undefined) executions.set(exec, session)
    return next()
  })

  const capture = async (target, actor, next) => {
    const intent = await next()
    const session = actor === undefined ? undefined : executions.get(actor)
    if (session === undefined) return intent
    const state = stateFor(session)
    if (state === null || state.store === null) return intent
    try {
      const absolute = ctx.fs.processPath(target)
      await state.store.capture({ absolute, path: displayPath(state.cwd, absolute, home), turn: state.turn })
    } catch (error) {
      ctx.logger?.warn?.(`session-diff: snapshot failed: ${String(error)}`)
    }
    return intent
  }

  ctx.on('fs/write-intent', (target, actor, next) => capture(target, actor, next), { prepend: true })
  ctx.on('fs/edit-intent', (target, actor, next) => capture(target, actor, next), { prepend: true })
  ctx.on('fs/delete-intent', (target, actor, next) => capture(target, actor, next), { prepend: true })

  const liveState = (sessionId) => sessions.get(sessionId) ?? null

  const receiptFor = async (sessionId) => {
    const live = liveState(sessionId)
    if (live !== null && live.events.length > 0) {
      await live.lastWrite
      return live.receipt ?? await buildReceipt({ events: live.events, cwd: live.cwd, sessionId: live.id, store: live.store, home })
    }
    const stored = findStoredReceipt(sessionId, home)
    if (stored !== null) return readStoredReceipt(stored)
    const resolved = findSessionLog(sessionId, home)
    if (resolved === null) return null
    const events = readSessionFile(resolved.file)
    return buildReceipt({ events, cwd: resolved.cwd, sessionId, store: null, home })
  }

  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/session-diff/receipt',
      handler: async (request, response) => {
        try {
          const sessionId = queryOf(request, 'session')
          const receipt = sessionId === null ? null : await receiptFor(sessionId)
          sendJson(response, receipt === null ? 404 : 200, receipt === null ? { ok: false, error: 'no receipt for that session' } : { ok: true, receipt })
        } catch (error) {
          sendJson(response, 500, { ok: false, error: messageOf(error) })
        }
      },
    }), 'session-diff: GET /session-diff/receipt')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/session-diff/export',
      handler: async (request, response) => {
        try {
          const sessionId = queryOf(request, 'session')
          const format = (queryOf(request, 'format') ?? 'markdown').toLowerCase()
          const receipt = sessionId === null ? null : await receiptFor(sessionId)
          if (receipt === null) {
            sendJson(response, 404, { ok: false, error: 'no receipt for that session' })
            return
          }
          const { body, contentType, extension } = exportPayload(receipt, format)
          response.statusCode = 200
          response.setHeader('content-type', contentType)
          response.setHeader('content-disposition', `attachment; filename="receipt-${receipt.session.id}.${extension}"`)
          response.end(body)
        } catch (error) {
          sendJson(response, 500, { ok: false, error: messageOf(error) })
        }
      },
    }), 'session-diff: GET /session-diff/export')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/session-diff/restore',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST')
          sendJson(response, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const body = await jsonBody(request)
          const receipt = body.session === undefined ? null : await receiptFor(String(body.session))
          if (receipt === null) {
            sendJson(response, 404, { ok: false, error: 'no receipt for that session' })
            return
          }
          const row = receipt.files.find(file => file.path === body.path)
          if (row === undefined) {
            sendJson(response, 404, { ok: false, error: `not a file in this receipt: ${String(body.path)}` })
            return
          }
          const store = new SnapshotStore({ dir: sessionReceiptDir(receipt.session.cwd, receipt.session.id, { home }), retentionDays: settings.retentionDays, maxBytes: settings.maxBytes, maxFileBytes: settings.maxFileBytes })
          const result = await store.restore({ path: row.path, absolute: absolutePath(receipt.session.cwd, row.path), expectedAfterHash: row.afterSha256, force: body.force === true })
          sendJson(response, result.ok ? 200 : 409, result)
        } catch (error) {
          sendJson(response, 500, { ok: false, error: messageOf(error) })
        }
      },
    }), 'session-diff: POST /session-diff/restore')
  }

  const tools = ctx.get('tools')
  if (tools !== undefined) {
    ctx.effect(() => tools.register({
      name: 'receipt',
      description: 'Print, compare, export, or restore the deterministic receipt of a session.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['print', 'compare', 'export', 'restore'], description: 'What to do.' },
          session: { type: 'string', description: 'Session id, or omit for the current session.' },
          compare: { type: 'string', description: 'The second session id for compare.' },
          format: { type: 'string', enum: ['markdown', 'json', 'html'], description: 'Export format.' },
          path: { type: 'string', description: 'Receipt-relative file path for restore.' },
          force: { type: 'boolean', description: 'Restore even when the file changed after the receipt.' },
        },
        required: ['action'],
      },
      execute: async (args, exec) => {
        const current = exec?.agent?.session
        const sessionId = typeof args.session === 'string' && args.session !== '' ? args.session : current?.id
        if (typeof sessionId !== 'string') throw new Error('No session to read a receipt for.')
        if (args.action === 'compare') {
          const left = await receiptFor(sessionId)
          const right = args.compare === undefined ? null : await receiptFor(String(args.compare))
          if (left === null || right === null) throw new Error('One of the sessions has no recordable receipt.')
          const { compareReceipts } = await import('./src/diff.mjs')
          return JSON.stringify(compareReceipts(left, right), null, 2)
        }
        if (args.action === 'export') {
          const receipt = await receiptFor(sessionId)
          if (receipt === null) throw new Error('That session has no receipt yet.')
          return exportPayload(receipt, String(args.format ?? 'markdown')).body
        }
        if (args.action === 'restore') {
          const receipt = await receiptFor(sessionId)
          const row = receipt?.files.find(file => file.path === args.path)
          if (receipt === null || row === undefined) throw new Error(`Not a file in this receipt: ${String(args.path)}`)
          const store = new SnapshotStore({ dir: sessionReceiptDir(receipt.session.cwd, receipt.session.id, { home }), retentionDays: settings.retentionDays, maxBytes: settings.maxBytes, maxFileBytes: settings.maxFileBytes })
          const result = await store.restore({ path: row.path, absolute: absolutePath(receipt.session.cwd, row.path), expectedAfterHash: row.afterSha256, force: args.force === true })
          if (!result.ok) throw new Error(result.reason ?? 'restore failed')
          return `Restored ${row.path} from its pre-session snapshot (${result.restoredBytes} bytes).`
        }
        const receipt = await receiptFor(sessionId)
        if (receipt === null) throw new Error('That session has no receipt yet.')
        const { summaryLines } = await import('./src/cli.mjs')
        return summaryLines(receipt).join('\n')
      },
    }), 'session-diff: receipt tool')
  }

  const commands = ctx.get('commands')
  if (commands !== undefined) {
    ctx.effect(() => commands.register({
      name: 'receipt',
      description: 'Print the deterministic receipt for this session, or compare two sessions.',
      input: { hint: '[print | compare <session>]' },
      handler: async (invocation) => {
        try {
          const tokens = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
          const action = tokens[0] ?? 'print'
          const current = invocation.agent?.session
          if (action === 'compare') {
            const left = tokens[1]
            const right = tokens[2]
            if (left === undefined || right === undefined) return { kind: 'error', text: 'Usage: /receipt compare <session-a> <session-b>' }
            const [first, second] = await Promise.all([receiptFor(left), receiptFor(right)])
            if (first === null || second === null) return { kind: 'error', text: 'One of the sessions has no recordable receipt.' }
            const { compareReceipts } = await import('./src/diff.mjs')
            return { kind: 'success', text: JSON.stringify(compareReceipts(first, second), null, 2) }
          }
          const sessionId = tokens[1] ?? current?.id
          const receipt = typeof sessionId === 'string' ? await receiptFor(sessionId) : null
          if (receipt === null) return { kind: 'error', text: 'That session has no receipt yet.' }
          const { summaryLines } = await import('./src/cli.mjs')
          return { kind: 'success', text: summaryLines(receipt).join('\n') }
        } catch (error) {
          return { kind: 'error', text: `Receipt failed: ${messageOf(error)}` }
        }
      },
    }), 'session-diff: /receipt command')
  }
}

/**
 * Render one receipt for export.
 * @param {object} receipt - the receipt.
 * @param {string} format - markdown, json, or html.
 * @returns {{body: string, contentType: string, extension: string}} the payload.
 */
export function exportPayload(receipt, format) {
  if (format === 'json') return { body: `${JSON.stringify(receipt, null, 2)}\n`, contentType: 'application/json; charset=utf-8', extension: 'json' }
  if (format === 'html') return { body: renderHtml(receipt), contentType: 'text/html; charset=utf-8', extension: 'html' }
  return { body: renderMarkdown(receipt), contentType: 'text/markdown; charset=utf-8', extension: 'md' }
}

/**
 * Find a stored receipt directory for a session id.
 * @param {string} sessionId - session id.
 * @param {string} home - home directory.
 * @returns {string | null} the session receipt directory.
 */
function findStoredReceipt(sessionId, home) {
  const root = receiptsRoot(home)
  try {
    for (const workspace of readdirSync(root)) {
      const dir = join(root, workspace, sessionId)
      if (existsSync(join(dir, 'receipt.json'))) return dir
    }
  } catch {
    return null
  }
  return null
}

/**
 * Find a session log for an id in any workspace.
 * @param {string} sessionId - session id.
 * @param {string} home - home directory.
 * @returns {{file: string, cwd: string} | null} the log path and its working directory.
 */
function findSessionLog(sessionId, home) {
  const root = join(home, '.dsh', 'sessions')
  try {
    for (const workspace of readdirSync(root)) {
      const file = join(root, workspace, sessionId, 'session.v4.jsonl.zstd')
      try {
        const header = readSessionHeader(file)
        if (typeof header?.cwd === 'string') return { file, cwd: header.cwd }
      } catch {
        continue
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * Write a UTF-8 file atomically, so a concurrent reader never sees a torn receipt.
 * @param {string} file - target path.
 * @param {string} text - content.
 */
function writeAtomic(file, text) {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, file)
}

/**
 * Read a query parameter without depending on the request URL parser.
 * @param {object} request - Node request.
 * @param {string} key - parameter name.
 * @returns {string | null} the value.
 */
function queryOf(request, key) {
  const url = new URL(request.url ?? '/', 'http://localhost')
  return url.searchParams.get(key)
}

/**
 * Read a bounded JSON request body.
 * @param {object} request - Node request.
 * @returns {Promise<object>} the parsed body.
 */
async function jsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text)
}

/**
 * Send one JSON response.
 * @param {object} response - Node response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON value.
 */
function sendJson(response, status, body) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(`${JSON.stringify(body)}\n`)
}

/**
 * A concise error message.
 * @param {unknown} error - thrown value.
 * @returns {string} the message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
