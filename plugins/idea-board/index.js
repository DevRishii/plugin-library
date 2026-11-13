/**
 * Host half of the idea board bundle.
 *
 * It owns two durable documents: the idea board, served to the widget over
 * `/idea-board/state`, and the Dream Board (dreams, discard ledger, run log),
 * served over `/dream-board/*`. The same plugin registers the Dreamer tools,
 * the `/dreamer` command, the recurring dreamer schedule, and the per-run caps
 * guard, so one owner serializes every write.
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUN_PROMPT, createDreamBoard, launchFleetSession, openStorageUnit } from './dreams.js'
import { NightmareError, buildSquashPrompt, createNightmareBoard } from './nightmares.js'

/** Cordis function-plugin name. */
export const name = 'idea-board'
/** The route carrier is the only hard dependency; storage is read optionally. */
export const inject = ['webServer']

const ROUTE = '/idea-board/state'
const HEALTH_ROUTE = '/idea-board/health'
const DREAM_ROUTE = '/dream-board/state'
const PURSUE_ROUTE = '/dream-board/pursue'
const BRIEF_ROUTE = '/dream-board/brief'
const DISCARD_ROUTE = '/dream-board/discard'
const SCHEDULE_ROUTE = '/dream-board/schedule'
const NIGHTMARE_ROUTE = '/nightmare-board/state'
const NIGHTMARE_DECIDE_ROUTE = '/nightmare-board/decide'
const NIGHTMARE_SQUASH_ROUTE = '/nightmare-board/squash'
const NIGHTMARE_RUN_ROUTE = '/nightmare-board/run'
const UNIT_NAME = 'idea_board'
const UNIT_VERSION = 1
const TABLE = 'state'
const RECORD = 'current'
const MAX_BODY_BYTES = 512 * 1024
const MAX_ITEMS = 500
const MAX_TEXT = 500
const MAX_DIMENSION = 4000
const MIN_WIDTH = 240
const MIN_HEIGHT = 160
const DOCTOR_TIMEOUT_MS = 120_000
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))
/** Workspace that owns this linked bundle; its sibling dsh-doctor is the default. */
const WORKSPACE_DIR = path.resolve(PACKAGE_DIR, '..')

/**
 * Run one child process and capture its output through files rather than
 * pipes. Confined Windows sandboxes deny anonymous pipes, so a piped
 * `execFile` fails there while an inherited file descriptor still works.
 * @param command - executable to launch.
 * @param args - arguments passed verbatim.
 * @param options - cwd and environment for the child.
 * @returns the exit code and captured output; a spawn failure rejects.
 */
function runCaptured(command, args, options) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-run-'))
    const stdoutPath = path.join(dir, 'stdout.txt')
    const stderrPath = path.join(dir, 'stderr.txt')
    const outFd = openSync(stdoutPath, 'w')
    const errFd = openSync(stderrPath, 'w')
    let settled = false
    const cleanup = () => {
      for (const fd of [outFd, errFd]) {
        try { closeSync(fd) } catch { /* already closed by the OS on exit */ }
      }
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    })
    const timer = setTimeout(() => {
      if (!settled) child.kill()
    }, DOCTOR_TIMEOUT_MS)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort temp cleanup */ }
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      let stdout = ''
      let stderr = ''
      try { stdout = readFileSync(stdoutPath, 'utf8') } catch { /* no output written */ }
      try { stderr = readFileSync(stderrPath, 'utf8') } catch { /* no output written */ }
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort temp cleanup */ }
      resolve({ code, stdout, stderr })
    })
  })
}

/** A request body the client must fix before retrying. */
class BadRequest extends Error {}

/**
 * Build the document a board starts from.
 * @returns the empty document with revision zero.
 */
function emptyDocument() {
  return {
    version: 1,
    revision: 0,
    items: [],
    ui: { collapsed: false, docked: false, x: null, y: null, width: null, height: null, tab: 'ideas', wide: false },
  }
}

/**
 * Read one optional coordinate.
 * @param value - candidate value from stored or submitted data.
 * @returns a rounded finite number, or null when absent.
 */
function coordinate(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

/**
 * Read one optional window dimension.
 * @param value - candidate value from stored or submitted data.
 * @param min - smallest accepted value.
 * @returns a rounded dimension inside the accepted range, or null.
 */
function dimension(value, min) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(MAX_DIMENSION, Math.max(min, Math.round(value)))
}

/**
 * Sanitize the widget's layout state.
 * @param value - submitted `ui` object.
 * @returns the accepted layout fields.
 */
function sanitizeUi(value) {
  if (value === null || typeof value !== 'object') return emptyDocument().ui
  return {
    collapsed: value.collapsed === true,
    docked: value.docked === true,
    x: coordinate(value.x),
    y: coordinate(value.y),
    width: dimension(value.width, MIN_WIDTH),
    height: dimension(value.height, MIN_HEIGHT),
    tab: value.tab === 'dreams' ? 'dreams' : value.tab === 'nightmares' ? 'nightmares' : 'ideas',
    wide: value.wide === true,
  }
}

/**
 * Sanitize and bound the submitted item list.
 * @param value - submitted `items` array.
 * @returns the accepted items.
 */
function sanitizeItems(value) {
  if (!Array.isArray(value)) return []
  const items = []
  const seen = new Set()
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue
    const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, MAX_TEXT) : ''
    if (text === '') continue
    let id = typeof raw.id === 'string' && raw.id !== '' ? raw.id.slice(0, 80) : randomUUID()
    if (seen.has(id)) id = randomUUID()
    seen.add(id)
    items.push({
      id,
      text,
      done: raw.done === true,
      createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
        ? Math.max(0, Math.round(raw.createdAt))
        : Date.now(),
    })
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

/**
 * Project a stored or submitted document onto the accepted format.
 * @param value - stored record or request payload.
 * @param revision - revision the projection must carry.
 * @returns the sanitized document.
 */
function sanitizeDocument(value, revision) {
  if (value === null || typeof value !== 'object') {
    return { ...emptyDocument(), revision }
  }
  return { version: 1, revision, items: sanitizeItems(value.items), ui: sanitizeUi(value.ui) }
}

/**
 * Read a bounded JSON request body.
 * @param req - the incoming request.
 * @returns the decoded JSON value.
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new BadRequest(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    throw new BadRequest(`request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Answer one request with JSON.
 * @param res - the response to complete.
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload.
 */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Describe a thrown value for the wire.
 * @param error - the caught value.
 * @returns a short message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve the plugin configuration with explicit defaults.
 * @param raw - the row's config object.
 * @returns the validated settings.
 */
function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const rawTime = typeof input.dailyTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(input.dailyTime)
    ? input.dailyTime
    : '09:00'
  const time = rawTime.length === 5 ? `${rawTime}:00` : rawTime
  const zone = typeof input.timeZone === 'string' && input.timeZone !== ''
    ? input.timeZone
    : Intl.DateTimeFormat().resolvedOptions().timeZone
  const positive = (value, fallback, max) => (typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(max, Math.round(value))
    : fallback)
  return {
    dailyTime: time,
    timeZone: zone,
    projectCwd: typeof input.projectCwd === 'string' ? input.projectCwd.trim() : '',
    activityHome: typeof input.activityHome === 'string' ? input.activityHome.trim() : '',
    doctorScript: typeof input.doctorScript === 'string' ? input.doctorScript.trim() : '',
    doctorCwd: typeof input.doctorCwd === 'string' ? input.doctorCwd.trim() : '',
    maxActiveDreams: positive(input.maxActiveDreams, 10, 100),
    maxNewDreamsPerRun: typeof input.maxNewDreamsPerRun === 'number' && Number.isFinite(input.maxNewDreamsPerRun)
      ? Math.min(5, Math.max(0, Math.round(input.maxNewDreamsPerRun)))
      : 1,
    maxWebCalls: positive(input.maxWebCalls, 12, 100),
    maxSubagents: positive(input.maxSubagents, 3, 20),
    autoSchedule: input.autoSchedule !== false,
  }
}

/**
 * Register the idea board, Dream Board, Dreamer tools, command, and loop.
 * @param ctx - the plugin context.
 * @param rawConfig - the row's config object.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  /** Open storage plus the cached idea document; null until the first request. */
  const cache = { unit: null, document: null }
  /** In-flight open, retained across concurrent requests. */
  let opening = null
  /** Serializes idea-board writes so revision assignment cannot interleave. */
  let queue = Promise.resolve()

  /**
   * Open the idea storage unit once and load the saved document. Later calls
   * answer the in-memory document so a completed write is visible immediately.
   * @returns the current document.
   */
  const open = async () => {
    if (cache.document !== null) return cache.document
    if (opening === null) {
      opening = (async () => {
        const hub = ctx.get('storage')
        if (hub === undefined) throw new Error('the storage service is not available in this profile')
        const names = hub.backend.names()
        const backendName = names.includes('json') ? 'json' : names[0]
        if (backendName === undefined) throw new Error('no storage backend is mounted')
        const backend = hub.backend.get(backendName)
        if (backend.kv === undefined) throw new Error(`storage backend "${backendName}" has no key-value facet`)
        const unit = await openStorageUnit(backend, UNIT_NAME, [TABLE])
        cache.unit = unit
        const loaded = await unit.loadAll()
        const stored = loaded.tables[TABLE] === undefined ? undefined : loaded.tables[TABLE][RECORD]
        const revision = stored !== null && typeof stored === 'object' && Number.isFinite(stored.revision)
          ? stored.revision
          : 0
        cache.document = sanitizeDocument(stored, revision)
        opening = null
        return cache.document
      })()
      opening.catch(() => {
        opening = null
      })
    }
    return opening
  }

  /**
   * Run one idea mutation after every earlier mutation settled.
   * @param task - the operation to serialize.
   * @returns the task's result.
   */
  const serialize = (task) => {
    const run = queue.then(task, task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Refuse a request that the connection trust fence rejects. */
  const fenced = (req, res) => {
    const connection = ctx.get('connection')
    const rejection = connection === undefined ? undefined : connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  const ideaHandler = async (req, res) => {
    if (fenced(req, res)) return

    if (req.method === 'GET') {
      try {
        sendJson(res, 200, { ok: true, state: await open() })
      } catch (error) {
        sendJson(res, 503, { ok: false, error: messageOf(error) })
      }
      return
    }

    if (req.method !== 'PUT') {
      res.setHeader('allow', 'GET, PUT')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    // Body-format validation: the essence must be exactly application/json.
    const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
    if (essence !== 'application/json') {
      sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
      return
    }

    try {
      const body = await readJson(req)
      const result = await serialize(async () => {
        const current = await open()
        const base = body === null || typeof body !== 'object' ? undefined : body.baseRevision
        if (typeof base === 'number' && base !== current.revision) {
          return { conflict: true, document: current }
        }
        const next = sanitizeDocument(body.state, current.revision + 1)
        await cache.unit.putRecord(TABLE, RECORD, next)
        cache.document = next
        return { conflict: false, document: next }
      })
      if (result.conflict) {
        sendJson(res, 409, { ok: false, code: 'conflict', state: result.document })
      } else {
        sendJson(res, 200, { ok: true, state: result.document })
      }
    } catch (error) {
      if (error instanceof BadRequest) {
        sendJson(res, 400, { ok: false, error: error.message })
      } else {
        sendJson(res, 503, { ok: false, error: messageOf(error) })
      }
    }
  }

  /** Read the idea board for ingest without exposing the write path. */
  const readIdeas = async () => {
    const document = await open()
    return document.items
  }

  const board = createDreamBoard(ctx, config, readIdeas)
  const nightmares = createNightmareBoard(ctx, config)

  /** Map a dream error onto a status code. */
  const dreamErrorStatus = (error) => {
    if (error instanceof BadRequest) return 400
    if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
      if (error.code === 'not-found') return 404
      if (error.code === 'busy') return 409
      if (error.code === 'invalid') return 400
    }
    return 503
  }

  /** Read one JSON body for a dream route. */
  const dreamBody = async (req) => {
    const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
    if (essence !== 'application/json') throw new BadRequest('content-type must be application/json')
    const body = await readJson(req)
    return body !== null && typeof body === 'object' ? body : {}
  }

  const dreamStateHandler = async (req, res) => {
    if (fenced(req, res)) return
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      await board.open()
      sendJson(res, 200, { ok: true, board: await board.state() })
    } catch (error) {
      sendJson(res, 503, { ok: false, error: messageOf(error) })
    }
  }

  const pursueHandler = async (req, res) => {
    if (fenced(req, res)) return
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = await dreamBody(req)
      await board.open()
      const result = await board.pursue(String(body.id ?? ''), typeof body.outDir === 'string' ? { outDir: body.outDir } : {})
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      sendJson(res, dreamErrorStatus(error), { ok: false, error: messageOf(error), code: error?.code })
    }
  }

  const briefHandler = async (req, res) => {
    if (fenced(req, res)) return
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = await dreamBody(req)
      await board.open()
      const options = typeof body.outDir === 'string' ? { outDir: body.outDir } : {}
      const result = body.attach === true
        ? await board.pursue(String(body.id ?? ''), options)
        : await board.brief(String(body.id ?? ''), options)
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      sendJson(res, dreamErrorStatus(error), { ok: false, error: messageOf(error), code: error?.code })
    }
  }

  const discardHandler = async (req, res) => {
    if (fenced(req, res)) return
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = await dreamBody(req)
      await board.open()
      const result = await board.discard(String(body.id ?? ''), typeof body.reason === 'string' ? body.reason : '')
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      sendJson(res, dreamErrorStatus(error), { ok: false, error: messageOf(error), code: error?.code })
    }
  }

  const scheduleHandler = async (req, res) => {
    if (fenced(req, res)) return
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = await dreamBody(req)
      await board.open()
      const result = await board.controlSchedule(String(body.action ?? ''))
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      sendJson(res, dreamErrorStatus(error), { ok: false, error: messageOf(error), code: error?.code })
    }
  }

  /** Nightmares with a repair session already starting, so a double click starts one. */
  const squashing = new Set()

  /** Resolve the directory a repair session works in. */
  const repairCwd = () => path.resolve(config.projectCwd !== '' ? config.projectCwd : process.cwd())

  /** Directory the deterministic doctor scan inspects. */
  const doctorRoot = () => path.resolve(
    config.doctorCwd !== '' ? config.doctorCwd : config.projectCwd !== '' ? config.projectCwd : WORKSPACE_DIR,
  )

  /**
   * Locate the dsh-doctor entry point: the configured path first, then the
   * workspace sibling bundle, then the scanned root's own copy.
   * @returns an absolute script path; it may not exist.
   */
  const doctorScriptPath = () => {
    if (config.doctorScript !== '') return path.resolve(config.doctorScript)
    const candidates = [
      path.join(WORKSPACE_DIR, 'dsh-doctor', 'bin', 'dsh-doctor.mjs'),
      path.join(doctorRoot(), 'dsh-doctor', 'bin', 'dsh-doctor.mjs'),
    ]
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
  }

  /** One doctor run at a time, so a double click cannot interleave ingests. */
  let doctorRunning = false

  /**
   * Run the workspace doctor once and fold its `--nightmares` feed into the
   * backlog. Exit code 1 means defects were found, not that the run failed, so
   * the feed on stdout is still consumed.
   * @returns `{ board, run, summary, generatedAt }`.
   */
  const runDoctor = async () => {
    if (doctorRunning) throw new NightmareError('a doctor run is already in progress', 'busy')
    doctorRunning = true
    try {
      const script = doctorScriptPath()
      if (!existsSync(script)) throw new NightmareError(`dsh-doctor was not found at ${script}`, 'doctor-missing')
      const root = doctorRoot()
      const result = await runCaptured(process.execPath, [script, '--nightmares', '--root', root], {
        cwd: root,
        // Electron's executable is Node only when this marker is set; plain
        // Node ignores it.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      let feed
      try {
        feed = JSON.parse(result.stdout)
      } catch {
        const detail = result.stderr.trim().split(/\r?\n/)[0] ?? ''
        throw new NightmareError(
          detail === '' ? 'dsh-doctor produced no readable JSON feed' : `dsh-doctor failed: ${detail}`,
          'doctor-output',
        )
      }
      if (feed === null || typeof feed !== 'object'
        || (!Array.isArray(feed.findings) && !Array.isArray(feed.passing))) {
        throw new NightmareError('dsh-doctor produced no readable JSON feed', 'doctor-output')
      }
      const findings = Array.isArray(feed.findings) ? feed.findings : []
      const passing = Array.isArray(feed.passing) ? feed.passing : []
      await nightmares.open()
      const run = findings.length === 0 && passing.length === 0
        ? { added: 0, updated: 0, reopened: 0, cleared: 0, submitted: 0, sessionId: null, skipped: true }
        : { ...(await nightmares.ingest({ findings, passing, source: 'dsh-doctor' })), skipped: false }
      return { board: await nightmares.state(), run, summary: feed.summary ?? null, generatedAt: feed.generatedAt ?? null }
    } finally {
      doctorRunning = false
    }
  }

  /**
   * Start one Fleet repair session for a nightmare and mark it in progress.
   * @param id - nightmare id.
   * @returns `{ nightmare, sessionId }`.
   */
  const squashNightmare = async (id) => {
    await nightmares.open()
    const nightmare = await nightmares.get(id)
    if (nightmare === null) throw new NightmareError(`unknown nightmare: ${id}`, 'not-found')
    if (squashing.has(id)) throw new NightmareError('a repair session for this nightmare is already starting', 'busy')
    squashing.add(id)
    try {
      const cwd = repairCwd()
      const launch = await launchFleetSession(ctx, {
        title: `Squash nightmare: ${nightmare.checkId}`,
        prompt: buildSquashPrompt(nightmare, { cwd }),
        cwd,
      })
      const updated = await nightmares.beginSquash(id, launch.sessionId)
      return { nightmare: updated, sessionId: launch.sessionId }
    } finally {
      squashing.delete(id)
    }
  }

  const nightmareStateHandler = async (req, res) => {
    if (fenced(req, res)) return
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      await nightmares.open()
      sendJson(res, 200, { ok: true, board: await nightmares.state() })
    } catch (error) {
      sendJson(res, 503, { ok: false, error: messageOf(error) })
    }
  }

  const nightmareDecideHandler = async (req, res) => {
    if (fenced(req, res)) return
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = await dreamBody(req)
      await nightmares.open()
      const nightmare = await nightmares.decide({
        id: String(body.id ?? ''),
        action: String(body.action ?? ''),
        comment: typeof body.comment === 'string' ? body.comment : undefined,
      })
      sendJson(res, 200, { ok: true, nightmare })
    } catch (error) {
      sendJson(res, dreamErrorStatus(error), { ok: false, error: messageOf(error), code: error?.code })
    }
  }

  const nightmareSquashHandler = async (req, res) => {
    if (fenced(req, res)) return
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = await dreamBody(req)
      const result = await squashNightmare(String(body.id ?? ''))
      sendJson(res, 200, { ok: true, nightmare: result.nightmare, sessionId: result.sessionId })
    } catch (error) {
      sendJson(res, dreamErrorStatus(error), { ok: false, error: messageOf(error), code: error?.code })
    }
  }

  const nightmareRunHandler = async (req, res) => {
    if (fenced(req, res)) return
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      sendJson(res, 200, { ok: true, ...(await runDoctor()) })
    } catch (error) {
      sendJson(res, dreamErrorStatus(error), { ok: false, error: messageOf(error), code: error?.code })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: ideaHandler }), `idea-board: GET/PUT ${ROUTE}`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: HEALTH_ROUTE,
    handler: (req, res) => {
      if (fenced(req, res)) return
      sendJson(res, 200, { ok: true })
    },
  }), 'idea-board: health route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: DREAM_ROUTE, handler: dreamStateHandler }), `idea-board: GET ${DREAM_ROUTE}`)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: PURSUE_ROUTE, handler: pursueHandler }), `idea-board: POST ${PURSUE_ROUTE}`)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: BRIEF_ROUTE, handler: briefHandler }), `idea-board: POST ${BRIEF_ROUTE}`)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: DISCARD_ROUTE, handler: discardHandler }), `idea-board: POST ${DISCARD_ROUTE}`)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: SCHEDULE_ROUTE, handler: scheduleHandler }), `idea-board: POST ${SCHEDULE_ROUTE}`)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: NIGHTMARE_ROUTE, handler: nightmareStateHandler }), `idea-board: GET ${NIGHTMARE_ROUTE}`)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: NIGHTMARE_DECIDE_ROUTE, handler: nightmareDecideHandler }), `idea-board: POST ${NIGHTMARE_DECIDE_ROUTE}`)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: NIGHTMARE_SQUASH_ROUTE, handler: nightmareSquashHandler }), `idea-board: POST ${NIGHTMARE_SQUASH_ROUTE}`)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: NIGHTMARE_RUN_ROUTE, handler: nightmareRunHandler }), `idea-board: POST ${NIGHTMARE_RUN_ROUTE}`)

  /** JSON-schema fragment for the rubric scores. */
  const scoreSchema = {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(['value', 'niche', 'revenue', 'feasibility', 'fit'].map((key) => [key, {
      type: 'integer', minimum: 1, maximum: 5, description: `1-5 score for ${key}.`,
    }])),
  }

  const dreamSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: 'Existing dream id to refine; omit for a new dream.' },
      title: { type: 'string', description: 'Short specific product or feature name; no generic "AI for X".' },
      pitch: { type: 'string', description: 'One-line pitch: who it is for and the outcome it delivers.' },
      type: { type: 'string', enum: ['feature', 'application', 'service'], description: 'Feature extends an existing project; application is a standalone app; service is a hosted or API product.' },
      problem: { type: 'string', description: 'The specific recurring problem, with evidence it is actively felt.' },
      targetUser: { type: 'string', description: 'A named, narrow user segment. Not "everyone".' },
      value: { type: 'string', description: 'Why this is materially better than the status quo.' },
      monetization: { type: 'string', description: 'Who pays, pricing model, rough market size; "n/a" only for features.' },
      competitive: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string' },
          competitors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                url: { type: 'string' },
                pricing: { type: 'string', description: 'Actual published or researched pricing.' },
                gap: { type: 'string', description: 'What they do not cover for this user.' },
              },
              required: ['name'],
            },
          },
        },
      },
      architecture: { type: 'string', description: 'Technical outline: stack, data model, key components, risks.' },
      mvpScope: { type: 'array', items: { type: 'string' }, description: 'Smallest shippable scope, one bullet per capability.' },
      effort: { type: 'string', description: 'Rough effort for a solo dev or small team.' },
      sources: {
        type: 'object',
        additionalProperties: false,
        properties: {
          web: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { url: { type: 'string' }, title: { type: 'string' } },
              required: ['url'],
            },
          },
          ideas: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { id: { type: 'string' }, title: { type: 'string' } },
              required: ['title'],
            },
          },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { id: { type: 'string' }, title: { type: 'string' } },
              required: ['title'],
            },
          },
        },
      },
      scores: scoreSchema,
      tags: { type: 'array', items: { type: 'string' } },
      status: { type: 'string', enum: ['incubating', 'ready_for_review'] },
      distinction: { type: 'string', description: 'Required when a discarded/pursued dream is conceptually similar: how this materially differs.' },
    },
  }

  /** Render a tool value as one text block. */
  const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  const toolOutput = { schema: { type: 'object', additionalProperties: true }, render: renderJson }

  const dreamTools = [
    {
      name: 'dream_context',
      description: 'Ingest one Dreamer run: the idea board, compact recent-session activity receipts, a compact active-dream index with missing sections, the binding pursued history, recent discards, the scoring rubric, the run caps, and the run lock. Call this first in every run; if `locked` is true another run is active and you must stop without writing.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: toolOutput,
      execute: async (_args, exec) => board.context(exec?.agent?.id),
    },
    {
      name: 'dream_get',
      description: 'Read one dream\'s full stored record by id, including the fields the compact board index omits (problem, user, competitive, architecture, MVP, sources, revision log). Read-only; use it for the one or two dreams you will deepen.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Dream id from `dream_context`.' },
        },
      },
      output: toolOutput,
      execute: async (args) => {
        await board.open()
        const dream = board.get(String(args?.id ?? ''))
        if (dream === undefined) throw new Error(`unknown dream: ${String(args?.id ?? '')}`)
        return { dream }
      },
    },
    {
      name: 'dream_save',
      description: 'Create or deepen one dream on the Dream Board. Send the complete dream object: omitted fields keep their stored values on an update. Refining requires both the `id` and the exact `title`; an unknown id or mismatched title is rejected so a typo cannot overwrite another dream. The store enforces the active cap, the per-run new-dream cap, computes the total score, promotes a dream when the review bar is met, appends the change to the revision log, and rejects a concept that duplicates the pursued, discarded, or retired ledger unless `distinction` states how it materially differs. `mergedFrom` retires the listed dreams into this one.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['dream', 'change'],
        properties: {
          id: { type: 'string', description: 'Existing dream id to refine (alias for dream.id); omit for a new dream.' },
          dream: dreamSchema,
          change: { type: 'string', description: 'One sentence naming what was added or sharpened in this iteration.' },
          mergedFrom: { type: 'array', items: { type: 'string' }, description: 'Dream ids absorbed by this one.' },
          distinction: { type: 'string', description: 'Required when the concept resembles a discarded, retired, or pursued dream.' },
        },
      },
      output: toolOutput,
      execute: async (args, exec) => {
        await board.open()
        const dream = args !== null && typeof args === 'object' && args.dream !== null && typeof args.dream === 'object' ? args.dream : {}
        const id = typeof dream.id === 'string' ? dream.id : typeof args?.id === 'string' ? args.id : undefined
        return board.save(
          { ...dream, id, change: args?.change, mergedFrom: args?.mergedFrom, distinction: args?.distinction ?? dream.distinction },
          exec?.agent?.id,
        )
      },
    },
    {
      name: 'dream_retire',
      description: 'Retire one active dream that no longer holds up. Moves it to the discard ledger with outcome "retired" so no later run proposes it again.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'reason'],
        properties: {
          id: { type: 'string', description: 'Dream id.' },
          reason: { type: 'string', description: 'Why it no longer holds up; this becomes the ledger reason.' },
        },
      },
      output: toolOutput,
      execute: async (args, exec) => {
        await board.open()
        return board.retire(String(args?.id ?? ''), String(args?.reason ?? 'dreamer-retired'), 'retired')
      },
    },
    {
      name: 'dream_schedule',
      description: 'Control the Dream Board dreamer loop: run it now, inspect its schedule, or pause/resume it. A manual run opens a new dreamer session; it never overlaps another active run.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['run', 'status', 'pause', 'resume'], description: 'Which schedule operation to perform.' },
        },
      },
      output: toolOutput,
      execute: async (args, exec) => {
        await board.open()
        const action = String(args?.action ?? 'status')
        if (action === 'status') return board.state()
        if (action === 'run' || action === 'pause' || action === 'resume') return board.controlSchedule(action)
        throw new Error(`unknown dream schedule action: ${action}`)
      },
    },
    {
      name: 'dream_summary',
      description: 'Finish one Dreamer run: record the run summary in the run log and release the run lock. List added / refined / promoted / retired / skipped-as-duplicate titles. Always call this last.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          added: { type: 'array', items: { type: 'string' } },
          refined: { type: 'array', items: { type: 'string' } },
          promoted: { type: 'array', items: { type: 'string' } },
          retired: { type: 'array', items: { type: 'string' } },
          skipped: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
      },
      output: toolOutput,
      execute: async (args, exec) => {
        await board.open()
        return board.summary(args ?? {}, exec?.agent?.id)
      },
    },
    {
      name: 'nightmare_add',
      description: 'Adds the findings from one dsh-doctor run to the nightmare backlog, deduplicating by check id and evidence so a rescan updates rather than duplicates. Send `passing` as well: a check that now passes closes its open nightmare, so a repaired defect leaves the backlog without a manual step.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['findings'],
        properties: {
          findings: {
            type: 'array',
            items: { type: 'object', additionalProperties: true, description: 'One defect finding from a `dsh-doctor --nightmares` feed.' },
          },
          passing: {
            type: 'array',
            items: { type: 'string' },
            description: 'Check ids that ran and passed; the open nightmare for each one closes as fixed.',
          },
          source: { type: 'string', description: 'Where the findings came from; defaults to `dsh-doctor`.' },
        },
      },
      output: toolOutput,
      execute: async (args, exec) => {
        await nightmares.open()
        const source = typeof args?.source === 'string' && args.source.trim() !== '' ? args.source : 'dsh-doctor'
        return nightmares.ingest(
          {
            findings: Array.isArray(args?.findings) ? args.findings : [],
            passing: Array.isArray(args?.passing) ? args.passing : [],
            source,
          },
          exec?.agent?.id,
        )
      },
    },
    {
      name: 'nightmare_squash',
      description: 'Start one Fleet repair session for a nightmare: it receives the finding, its evidence, the suggested fix, and the acceptance check that must pass. The nightmare moves to `accepted` and stays there until a doctor run reports that check passing, which closes it. One click from the Nightmares tab calls the same path.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Nightmare id from `nightmare_list`.' },
        },
      },
      output: toolOutput,
      execute: async (args) => {
        const result = await squashNightmare(String(args?.id ?? ''))
        return { ...result }
      },
    },
    {
      name: 'nightmare_list',
      description: 'List the nightmare backlog with counts, newest and most severe first.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: toolOutput,
      execute: async () => {
        await nightmares.open()
        return nightmares.state()
      },
    },
    {
      name: 'nightmare_decide',
      description: 'Record the approver\'s decision on one nightmare when it is not being squashed: `ignore` (keep it on the board, with a reason) or `remove` (drop it, with a reason), or `reopen` a decided one. Squashing has its own tool, `nightmare_squash`.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'action'],
        properties: {
          id: { type: 'string', description: 'Nightmare id from `nightmare_list`.' },
          action: { type: 'string', enum: ['accept', 'fix', 'ignore', 'remove', 'reopen'], description: 'The decision to apply.' },
          comment: { type: 'string', description: 'Why: required for `ignore` and `remove`.' },
        },
      },
      output: toolOutput,
      execute: async (args, exec) => {
        await nightmares.open()
        return nightmares.decide(
          {
            id: String(args?.id ?? ''),
            action: String(args?.action ?? ''),
            comment: typeof args?.comment === 'string' ? args.comment : undefined,
          },
          exec?.agent?.id,
        )
      },
    },
  ]

  const tools = ctx.get('tools')
  if (tools !== undefined) {
    ctx.effect(() => {
      const disposers = dreamTools.map((definition) => tools.register(definition))
      return () => { for (const dispose of disposers) dispose() }
    }, 'idea-board: dreamer tools')
  }

  const commands = ctx.get('commands')
  if (commands !== undefined) {
    ctx.effect(() => commands.register({
      name: 'dreamer',
      description: 'Run, pause, resume, or inspect the Dream Board dreamer loop.',
      input: { hint: 'run | status | pause | resume' },
      handler: async (invocation) => {
        const action = invocation.rawInput.trim().toLowerCase() || 'run'
        try {
          await board.open()
          if (action === 'status') {
            const state = await board.state()
            const task = state.schedule.task
            return {
              kind: 'success',
              text: [
                `Dreamer schedule: ${state.schedule.available ? (task === null ? 'missing' : task.status) : 'unavailable'}`,
                task === null ? '' : `Next delivery: ${task.scheduledAt}`,
                `Dreams: ${state.counts.active} active (${state.counts.ready} ready) · ${state.counts.discards} in discard memory`,
                state.lastRun === null ? 'No run recorded yet.' : `Last run: ${new Date(state.lastRun.at).toISOString()} — added ${state.lastRun.added.length}, refined ${state.lastRun.refined.length}, promoted ${state.lastRun.promoted.length}, retired ${state.lastRun.retired.length}`,
              ].filter((line) => line !== '').join('\n'),
            }
          }
          if (action === 'pause' || action === 'resume' || action === 'run') {
            const result = await board.controlSchedule(action)
            if (action === 'run') {
              return {
                kind: 'success',
                text: `Dreamer run started${result.sessionId === null ? '' : ` in session ${result.sessionId}`}. The run summary appears on the Dream Board when it finishes.`,
              }
            }
            return { kind: 'success', text: `Dreamer schedule ${action === 'pause' ? 'paused' : 'resumed'}.` }
          }
          return { kind: 'error', text: 'Usage: /dreamer [run|status|pause|resume]' }
        } catch (error) {
          return { kind: 'error', text: `Dreamer command failed: ${messageOf(error)}` }
        }
      },
    }), 'idea-board: /dreamer command')

    ctx.effect(() => commands.register({
      name: 'dream',
      description: 'Render a Fleet-ready build packet from a Dream Board dream, optionally starting the buildout.',
      input: { hint: 'brief <id> [--attach] [--out <dir>] | list' },
      handler: async (invocation) => {
        const tokens = invocation.rawInput.trim() === '' ? [] : invocation.rawInput.trim().split(/\s+/u)
        const positional = []
        let attach = false
        let outDir = ''
        for (let index = 0; index < tokens.length; index += 1) {
          const token = tokens[index]
          if (token === '--attach') {
            attach = true
            continue
          }
          if (token === '--out') {
            const value = tokens[index + 1]
            if (value === undefined || value.startsWith('--')) {
              return { kind: 'error', text: '--out needs a directory path.' }
            }
            outDir = value
            index += 1
            continue
          }
          if (token.startsWith('--out=')) {
            const value = token.slice('--out='.length)
            if (value === '') return { kind: 'error', text: '--out needs a directory path.' }
            outDir = value
            continue
          }
          if (token.startsWith('--')) {
            return { kind: 'error', text: `Unknown option: ${token}. Usage: /dream brief <id> [--attach] [--out <dir>]` }
          }
          positional.push(token)
        }
        const action = positional[0] ?? 'list'
        try {
          if (action === 'list' || (action === 'brief' && positional[1] === undefined)) {
            await board.open()
            const all = board.listDreams()
            const ready = all.filter((dream) => dream.status === 'ready_for_review')
            const listed = ready.length > 0 ? ready : all
            if (listed.length === 0) return { kind: 'success', text: 'The Dream Board is empty. Run /dreamer to generate dreams.' }
            return {
              kind: 'success',
              text: [
                action === 'brief' ? 'Usage: /dream brief <id> [--attach] [--out <dir>]' : 'Dreams:',
                ...listed.slice(0, 12).map((dream) => `${dream.id} — ${dream.title} (${dream.totalScore}/25, ${dream.status})`),
              ].join('\n'),
            }
          }
          if (action !== 'brief') {
            return { kind: 'error', text: 'Usage: /dream brief <id> [--attach] [--out <dir>] | /dream list' }
          }
          const id = positional[1]
          const options = outDir === '' ? {} : { outDir }
          const result = attach ? await board.pursue(id, options) : await board.brief(id, options)
          const lines = [
            attach ? `Fleet buildout started for "${result.title}".` : `Build packet written for "${result.title}".`,
            `Packet: ${result.briefPath}`,
            `Checks: ${result.checksPath} (${result.checkCount} check${result.checkCount === 1 ? '' : 's'})`,
            `Template: ${result.templatePath}`,
          ]
          if (result.sessionId !== undefined && result.sessionId !== null) lines.push(`Session: ${result.sessionId}`)
          if (result.unresolvedSlots.length > 0) {
            lines.push(`Warning: unknown template slots left as-is: ${result.unresolvedSlots.join(', ')}`)
          }
          lines.push(attach
            ? 'The dream moved to discard memory; the Fleet session starts in about a minute.'
            : 'The dream stays on the board. Add --attach to start the Fleet buildout.')
          return { kind: 'success', text: lines.join('\n') }
        } catch (error) {
          return { kind: 'error', text: `Build packet failed: ${messageOf(error)}` }
        }
      },
    }), 'idea-board: /dream command')
  }

  // Per-run caps: one agent-scoped guard counts web and subagent calls for a
  // dreamer session and denies the call that would exceed the configured cap.
  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (agent === undefined || agent.ctx === undefined) return
    let preset
    try {
      preset = ctx.get('agentPresets')?.composedPreset(agent.ctx)
    } catch {
      return
    }
    if (preset !== 'dreamer') return
    let tools
    try {
      tools = agent.ctx.tools
    } catch {
      return
    }
    if (tools === undefined) return
    let reported = false
    try {
      agent.ctx.on('turn/end', (payload) => {
        if (reported) return
        const kind = payload?.reason?.kind
        if (kind !== 'error' && kind !== 'interrupted') return
        reported = true
        const detail = kind === 'error' ? (payload.reason.error?.message ?? 'model error') : 'run interrupted'
        void board.recordFailure(agent.id, detail)
      })
    } catch (error) {
      console.warn('idea-board: could not watch dreamer turn errors', error)
    }
    const counts = { web: 0, subs: 0 }
    agent.ctx.effect(() => tools.guard((execution) => {
      if (execution.name === 'web_search' || execution.name === 'web_fetch') {
        counts.web += 1
        if (counts.web > config.maxWebCalls) return `Dreamer run cap reached: at most ${config.maxWebCalls} web calls. Finish with dream_summary.`
      }
      if (execution.name === 'subagent' || execution.name === 'subagent_fork') {
        counts.subs += 1
        if (counts.subs > config.maxSubagents) return `Dreamer run cap reached: at most ${config.maxSubagents} subagents.`
      }
      return undefined
    }), 'idea-board: dreamer caps')
  })

  ctx.effect(() => () => {
    const unit = cache.unit
    cache.unit = null
    cache.document = null
    return unit === null ? undefined : unit.close()
  }, 'idea-board: close idea storage')

  ctx.effect(() => {
    let disposed = false
    ctx.inject(['schedule'], () => {
      void (async () => {
        try {
          await board.open()
          if (!disposed && config.autoSchedule) await board.ensureSchedule()
        } catch (error) {
          console.warn('idea-board: dream board initialization failed', error)
        }
      })()
    })
    return () => {
      disposed = true
      return board.close()
    }
  }, 'idea-board: dream board')
}
