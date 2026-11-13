/**
 * Host half of the Session Tripwire bundle.
 *
 * One workspace-scoped ledger is shared by every Session opened against the
 * same workspace. Sessions register on start, write tools are checked against
 * other live holders before dispatch, and completed writes are recorded with a
 * SHA-256 content hash. The plugin also serves the board panel at
 * `/tripwire/board` and registers the `/tripwire` command.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { renderBoard } from './board.js'
import {
  DEFAULT_IGNORE,
  MODES,
  TRIPWIRE_CONFLICT,
  TripwireLedger,
  TripwireError,
  hashFile,
  warningText,
  writerIdFor,
} from './ledger.js'

/** Cordis function-plugin name. */
export const name = 'session-tripwire'
/** The board route is the only hard dependency. */
export const inject = ['webServer']

/** Tool names that mutate files and are checked before dispatch. */
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor'])

/** Routes served by the host half. */
const ROUTES = Object.freeze({
  board: '/tripwire/board',
  state: '/tripwire/state',
  action: '/tripwire/action',
  health: '/tripwire/health',
})

/** Maximum JSON body accepted by the board action route. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Resolve and validate the plugin configuration.
 * @param raw - raw loader configuration.
 * @returns the effective configuration.
 */
function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const root = typeof source.workspaceRoot === 'string' && source.workspaceRoot.trim() !== ''
    ? path.resolve(source.workspaceRoot)
    : process.cwd()
  const ttl = Number(source.ttlMs)
  const mode = MODES.includes(source.mode) ? source.mode : 'observe'
  return {
    root,
    mode,
    ttlMs: Number.isFinite(ttl) && ttl >= 1_000 ? Math.min(Math.floor(ttl), 86_400_000) : 120_000,
    ignore: Array.isArray(source.ignore) ? source.ignore.filter(entry => typeof entry === 'string') : [...DEFAULT_IGNORE],
  }
}

/** Read one JSON request body with a hard byte cap. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new TripwireError('request body is too large', 'BAD_REQUEST')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new TripwireError('request body is not valid JSON', 'BAD_REQUEST')
  }
}

/** Send one JSON response. */
function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(`${JSON.stringify(value)}\n`)
}

/** Send one HTML response. */
function sendHtml(res, status, html) {
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(html)
}

/** Extract the Session id from a tool execution's caller agent. */
function sessionIdOf(exec) {
  const agent = exec?.agent
  if (typeof agent === 'string') return agent
  if (agent !== null && agent !== undefined && typeof agent.id === 'string') return String(agent.id)
  return 'unknown'
}

/** Extract the Session id from a command invocation's agent. */
function sessionIdOfAgent(agent) {
  if (agent !== null && agent !== undefined && typeof agent.id === 'string') return String(agent.id)
  return 'unknown'
}

/**
 * Resolve one reported path to its real location. A missing final segment is
 * resolved through its nearest existing parent, so a new file still shares the
 * workspace's real path prefix.
 * @param root - workspace root used for relative paths.
 * @param target - tool-reported path.
 * @returns an absolute path.
 */
async function realTarget(root, target) {
  const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target)
  try {
    return stripWindowsPrefix(await fs.realpath(absolute))
  } catch {
    try {
      const parent = stripWindowsPrefix(await fs.realpath(path.dirname(absolute)))
      return path.join(parent, path.basename(absolute))
    } catch {
      return absolute
    }
  }
}

/** Drop the `\\?\` prefix Node returns on Windows realpath calls. */
function stripWindowsPrefix(value) {
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`
  return value.startsWith('\\\\?\\') ? value.slice(4) : value
}

/**
 * Extract the file paths a write tool is about to mutate.
 * @param tool - tool name.
 * @param args - parsed tool arguments.
 * @param root - workspace root for relative paths.
 * @returns absolute target paths, deduplicated.
 */
export function targetPaths(tool, args, root) {
  const targets = []
  const add = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value)
    if (!targets.includes(absolute)) targets.push(absolute)
  }
  if (tool === 'write' || tool === 'edit') {
    add(args?.file_path)
    add(args?.filePath)
  } else if (tool === 'str_replace_editor') {
    if (args?.command !== 'view') add(args?.path)
  } else if (tool === 'apply_patch') {
    const input = typeof args?.input === 'string' ? args.input : ''
    for (const match of input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)) add(match[1].trim())
    for (const match of input.matchAll(/^\*\*\* Move to: (.+)$/gmu)) add(match[1].trim())
  }
  return targets
}

/** Build the post-write stale-owner message. */
function staleMessage(stale) {
  const holder = stale.holder
  return `Session tripwire: this write raced another writer. ${holder.path} is now held by `
    + `session ${holder.sessionId} (fence ${holder.fence}); your fence is stale. The bytes were written, `
    + `but ownership did not transfer. Re-read the file and take ownership with `
    + `/tripwire claim ${holder.path} before continuing.`
}

/**
 * Register the host half.
 * @param ctx - Cordis context.
 * @param rawConfig - loader configuration.
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const ledger = new TripwireLedger({
    root: config.root,
    mode: config.mode,
    ttlMs: config.ttlMs,
    ignore: config.ignore,
  })
  const ready = ledger.open()
  void ready.catch((error) => {
    console.warn('session-tripwire: ledger initialization failed', error)
  })
  const sessions = new Map()
  const pending = new Map()

  /** Report a non-fatal ledger failure without turning it into a write denial. */
  const report = (context) => (error) => {
    console.warn(`session-tripwire: ${context}`, error)
  }

  /** Current writer id for a Session. */
  const writerOf = sessionId => sessions.get(sessionId)?.writerId ?? writerIdFor(sessionId, undefined, process.pid)

  /** Current workspace directory for a Session. */
  const cwdOf = sessionId => sessions.get(sessionId)?.cwd ?? config.root

  /** Effective directory for a call, including a mid-Session `cd`. */
  const sessionCwdOf = (exec, sessionId) => {
    const session = exec?.agent?.session
    if (session !== undefined) {
      try {
        const current = ctx.get('workingDirectory')?.get?.(session)
        if (typeof current === 'string' && current !== '') return current
      } catch {
        // Fall back to the creation directory when the projection is unavailable.
      }
    }
    return cwdOf(sessionId)
  }

  ctx.effect(() => ctx.on('session/created', (session) => {
    const sessionId = String(session?.id ?? 'unknown')
    const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : config.root
    const writerId = writerIdFor(sessionId, undefined, process.pid)
    sessions.set(sessionId, { writerId, cwd })
    void ready.then(() => ledger.registerWriter({
      writerId,
      sessionId,
      cwd,
      pid: process.pid,
      label: session?.header?.origin === 'subagent' ? 'subagent' : 'session',
    })).catch(report(`register session ${sessionId}`))
  }), 'session-tripwire: register sessions')

  ctx.effect(() => ctx.on('session/disposed', (session) => {
    const sessionId = String(session?.id ?? 'unknown')
    const record = sessions.get(sessionId)
    sessions.delete(sessionId)
    if (record !== undefined) {
      void ready.then(() => ledger.markOffline(record.writerId)).catch(report(`retire session ${sessionId}`))
    }
  }), 'session-tripwire: retire sessions')

  /** Release leases this call acquired before it failed, was blocked, or was cancelled. */
  async function releaseAcquired(results, writerId) {
    for (const previous of results) {
      if (previous.lease === undefined || previous.acquiredNew !== true) continue
      await ledger.release({ writerId, absPath: previous.absPath }).catch(() => {})
    }
  }

  /** Check every target of one write tool and reserve intent. */
  async function guardPre(exec) {
    if (!WRITE_TOOLS.has(exec?.name)) return undefined
    if (exec?.signal?.aborted === true) return undefined
    const sessionId = sessionIdOf(exec)
    const root = sessionCwdOf(exec, sessionId)
    const targets = targetPaths(exec.name, exec.arguments ?? {}, root)
    if (targets.length === 0) return undefined
    const writerId = writerOf(sessionId)
    const results = []
    try {
      await ready
      if (exec?.signal?.aborted === true) return undefined
      for (const target of targets) {
        if (exec?.signal?.aborted === true) {
          await releaseAcquired(results, writerId)
          return undefined
        }
        const absPath = await realTarget(root, target)
        const result = await ledger.beginWrite({
          writerId,
          sessionId,
          absPath,
          tool: exec.name,
          cwd: root,
        })
        results.push({ ...result, absPath })
        if (result.action === 'block') {
          await releaseAcquired(results, writerId)
          return { kind: 'deny', reason: result.reason, info: result.info }
        }
      }
      if (exec.token !== undefined) {
        if (pending.size >= 500) {
          const oldest = pending.keys().next().value
          pending.delete(oldest)
        }
        pending.set(exec.token, { at: Date.now(), tool: exec.name, writerId, sessionId, targets: results })
      }
      return undefined
    } catch (error) {
      // A tripwire fault must not become a write denial: observe-only fallback.
      await releaseAcquired(results, writerId)
      report(`pre-execute ${exec?.name ?? 'tool'}`)(error)
      return undefined
    }
  }

  /** Record completed writes and append the warn-mode notice. */
  async function guardPost(exec, result, next) {
    const entry = exec.token === undefined ? undefined : pending.get(exec.token)
    if (entry === undefined) return next()
    pending.delete(exec.token)
    if (exec?.signal?.aborted === true) return next()
    if (result.isError === true) {
      try {
        await ready
        for (const target of entry.targets) {
          if (target.acquiredNew !== true || target.lease === undefined) continue
          await ledger.release({ writerId: entry.writerId, absPath: target.absPath }).catch(() => {})
        }
      } catch (error) {
        report(`release failed write ${exec?.name ?? 'tool'}`)(error)
      }
      return next()
    }
    const warnings = []
    let stale = null
    try {
      await ready
      for (const target of entry.targets) {
        if (target.ignored === true || target.bypass === 'kill-switch' || target.action === 'block') continue
        const snapshot = await hashFile(target.absPath)
        const record = await ledger.recordWrite({
          writerId: entry.writerId,
          sessionId: entry.sessionId,
          absPath: target.absPath,
          fence: target.lease?.fence,
          preserveLease: target.observeOnly === true,
          tool: entry.tool,
          beforeHash: target.beforeHash ?? null,
          hash: snapshot?.hash ?? null,
          bytes: snapshot?.bytes ?? null,
          mtimeMs: snapshot?.mtimeMs ?? null,
          cwd: cwdOf(entry.sessionId),
        })
        if (record.stale === true) stale = record
        if (target.action === 'warn') warnings.push(warningText(target.conflict, record.write))
      }
    } catch (error) {
      report(`post-execute ${exec?.name ?? 'tool'}`)(error)
    }
    const base = await next()
    if (stale !== null) {
      return { kind: 'block', feedback: [{ type: 'text', text: staleMessage(stale) }] }
    }
    if (warnings.length === 0 || base.kind !== 'accept') return base
    // A value replacement cannot also carry content; leave it untouched.
    if (Object.hasOwn(base, 'value')) return base
    const content = Array.isArray(base.content) ? base.content : result.content
    if (!Array.isArray(content)) return base
    return {
      kind: 'accept',
      content: [...content, { type: 'text', text: warnings.join('\n\n') }],
      additionalContexts: base.additionalContexts,
    }
  }

  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await guardPre(exec)
    if (decision !== undefined) return decision
    return next()
  }), 'session-tripwire: pre-execute writes')

  ctx.effect(() => ctx.on('tools/post-execute', async (exec, result, next) => {
    return guardPost(exec, result, next)
  }), 'session-tripwire: post-execute writes')

  /** Build the board URL when the server has bound a port. */
  function boardUrl() {
    try {
      const origin = ctx.webServer.getOrigin?.()
      if (typeof origin === 'string' && origin !== '') return `${origin}${ROUTES.board}`
    } catch {
      // The server may not have bound when the command runs; use the relative route.
    }
    return ROUTES.board
  }

  /** Resolve the operator writer used by board actions. */
  const operatorWriter = (body) => {
    const sessionId = typeof body?.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : 'tripwire-board'
    return { writerId: writerIdFor(sessionId, undefined, process.pid), sessionId }
  }

  /** Serve the HTML board. */
  const boardHandler = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const status = await ledger.status()
      sendHtml(res, 200, renderBoard(status, { now: Date.now() }))
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  /** Serve the JSON snapshot. */
  const stateHandler = async (req, res) => {
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      sendJson(res, 200, { ok: true, status: await ledger.status() })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  /** Apply one board action. */
  const actionHandler = async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = await readJsonBody(req)
      const action = String(body?.action ?? '')
      switch (action) {
        case 'set-mode':
          await ledger.setMode(String(body.mode))
          break
        case 'kill':
          await ledger.setKillSwitch(true)
          break
        case 'revive':
          await ledger.setKillSwitch(false)
          break
        case 'ignore':
          await ledger.ignore(String(body.pattern ?? ''))
          break
        case 'unignore':
          await ledger.unignore(String(body.pattern ?? ''))
          break
        case 'claim': {
          const writer = operatorWriter(body)
          const absPath = await realTarget(config.root, String(body.path ?? ''))
          await ledger.claim({ ...writer, absPath, reason: 'board-claim' })
          break
        }
        case 'release': {
          const writer = operatorWriter(body)
          const absPath = await realTarget(config.root, String(body.path ?? ''))
          await ledger.release({ ...writer, absPath, force: true })
          break
        }
        default:
          throw new TripwireError(`unknown action ${action}`, 'BAD_ACTION')
      }
      sendJson(res, 200, { ok: true, status: await ledger.status() })
    } catch (error) {
      const status = error instanceof TripwireError ? 400 : 500
      sendJson(res, status, { ok: false, error: String(error?.message ?? error), code: error?.code })
    }
  }

  /** Serve a tiny liveness probe. */
  const healthHandler = async (req, res) => {
    try {
      const status = await ledger.status()
      sendJson(res, 200, {
        ok: true,
        mode: status.mode,
        killSwitch: status.killSwitch,
        writers: status.stats.liveWriters,
        leases: status.stats.activeLeases,
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  for (const [route, handler] of [
    [ROUTES.board, boardHandler],
    [ROUTES.state, stateHandler],
    [ROUTES.action, actionHandler],
    [ROUTES.health, healthHandler],
  ]) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route, handler }), `session-tripwire: ${route}`)
  }

  const commands = ctx.get('commands')
  if (commands !== undefined) {
    ctx.effect(() => commands.register({
      name: 'tripwire',
      description: 'Inspect or control the workspace write-intent ledger.',
      input: {
        hint: 'status | board | claim <path> | release <path> | ignore <glob> | unignore <glob> | mode <observe|warn|block> | kill | revive',
      },
      handler: async (invocation) => {
        const raw = String(invocation?.rawInput ?? '').trim()
        const tokens = raw === '' ? [] : raw.split(/\s+/u)
        const verb = (tokens[0] ?? 'status').toLowerCase()
        const rest = tokens.slice(1).join(' ')
        const sessionId = sessionIdOfAgent(invocation?.agent)
        try {
          await ready
          if (verb === 'status') {
            const status = await ledger.status()
            return {
              kind: 'success',
              text: [
                `Session Tripwire — mode ${status.mode}, kill switch ${status.killSwitch ? 'ON' : 'OFF'}`,
                `Workspace: ${status.root}`,
                `Writers: ${status.stats.liveWriters} live / ${status.stats.writers} total · leases ${status.stats.activeLeases} · writes ${status.stats.writes} · conflicts ${status.stats.conflicts}`,
                ...status.leases.slice(0, 8).map(lease => `- ${lease.path} — ${lease.sessionId} (fence ${lease.fence}, ${new Date(lease.expiresAt).toISOString()})`),
                `Board: ${boardUrl()}`,
              ].join('\n'),
            }
          }
          if (verb === 'board') return { kind: 'success', text: `Session Tripwire board: ${boardUrl()}` }
          if (verb === 'mode') {
            const mode = MODES.includes(rest.toLowerCase()) ? rest.toLowerCase() : ''
            if (mode === '') return { kind: 'error', text: 'Usage: /tripwire mode <observe|warn|block>' }
            await ledger.setMode(mode)
            return { kind: 'success', text: `Session Tripwire mode set to ${mode}.` }
          }
          if (verb === 'kill' || verb === 'revive') {
            const enabled = verb === 'kill'
            await ledger.setKillSwitch(enabled)
            return { kind: 'success', text: `Session Tripwire kill switch ${enabled ? 'ON — writes bypass the ledger' : 'OFF — enforcement resumed'}.` }
          }
          if (verb === 'ignore' || verb === 'unignore') {
            if (rest === '') return { kind: 'error', text: `Usage: /tripwire ${verb} <glob>` }
            if (verb === 'ignore') await ledger.ignore(rest)
            else await ledger.unignore(rest)
            return { kind: 'success', text: `Session Tripwire ignore list ${verb === 'ignore' ? 'added' : 'removed'} ${rest}.` }
          }
          if (verb === 'claim' || verb === 'release') {
            if (rest === '') return { kind: 'error', text: `Usage: /tripwire ${verb} <path>` }
            const absPath = await realTarget(sessionCwdOf(invocation, sessionId), rest)
            const writerId = writerOf(sessionId)
            if (verb === 'claim') {
              const lease = await ledger.claim({ writerId, sessionId, absPath, reason: 'command-claim' })
              return { kind: 'success', text: `Session Tripwire: ${sessionId} owns ${lease.path} at fence ${lease.fence} until ${new Date(lease.expiresAt).toISOString()}.` }
            }
            const released = await ledger.release({ writerId, absPath, force: true })
            return { kind: 'success', text: `Session Tripwire: ${released.released ? 'released' : 'no lease on'} ${rest}.` }
          }
          return { kind: 'error', text: 'Usage: /tripwire [status|board|claim <path>|release <path>|ignore <glob>|unignore <glob>|mode <observe|warn|block>|kill|revive]' }
        } catch (error) {
          return { kind: 'error', text: `Session Tripwire command failed: ${String(error?.message ?? error)}` }
        }
      },
    }), 'session-tripwire: /tripwire command')
  }

  return { ledger, ready, boardUrl }
}
