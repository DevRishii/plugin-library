/**
 * Workspace-scoped write-intent ledger for Session Tripwire.
 *
 * The ledger lives at `<workspace>/.dsh/tripwire/` and is shared by every
 * Session opened against that workspace. `state.json` is the atomically
 * replaced source of truth; `journal.jsonl` is an append-only audit trail and
 * a replay fallback when the snapshot is missing or unreadable. Writes are
 * recorded with a SHA-256 content hash so a later writer can see what changed
 * since its own read.
 */

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Default path patterns the ledger never treats as conflicts. */
export const DEFAULT_IGNORE = Object.freeze([
  '.dsh/**',
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '*.lock',
  'pnpm-lock.yaml',
  'package-lock.json',
])

/** Enforcement modes, from least to most disruptive. */
export const MODES = Object.freeze(['observe', 'warn', 'block'])

/** Structured error code carried by a block decision. */
export const TRIPWIRE_CONFLICT = 'TRIPWIRE_CONFLICT'

/** Internal journal path prefix; never leases the ledger's own files. */
const INTERNAL_PREFIX = '.dsh/tripwire/'

/** A typed ledger failure with a stable code. */
export class TripwireError extends Error {
  /**
   * @param message - human-readable failure.
   * @param code - stable code for callers and tests.
   */
  constructor(message, code) {
    super(message)
    this.name = 'TripwireError'
    this.code = code
  }
}

/**
 * Hash one UTF-8 string.
 * @param text - content to hash.
 * @returns lowercase SHA-256 hex.
 */
export function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Hash one file.
 * @param filePath - file to read.
 * @returns `{ hash, bytes, mtimeMs }`, or null when the file is absent or unreadable as a regular file.
 */
export async function hashFile(filePath) {
  try {
    const info = await fs.stat(filePath)
    if (!info.isFile()) return null
    const buffer = await fs.readFile(filePath)
    return { hash: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.byteLength, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

/**
 * Build the deterministic writer identity for one Session process.
 * @param sessionId - Session id.
 * @param agentId - agent id when it differs from the Session id.
 * @param pid - process id holding the writer.
 * @returns the writer id.
 */
export function writerIdFor(sessionId, agentId = undefined, pid = process.pid) {
  const session = String(sessionId ?? 'unknown')
  const agent = agentId === undefined || String(agentId) === session ? '' : `:${String(agentId)}`
  return `${session}${agent}:${pid}`
}

/**
 * Normalize one absolute path against the workspace root.
 * @param root - absolute workspace root.
 * @param absolutePath - candidate file path.
 * @param platform - platform whose case rules apply.
 * @returns `{ key, display, absPath }`, or null when the path is outside the root.
 */
export function normalizePath(root, absolutePath, platform = process.platform) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(absolutePath)
  const relative = path.relative(resolvedRoot, resolved)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  const display = relative.split(path.sep).join('/')
  return {
    key: platform === 'win32' ? display.toLowerCase() : display,
    display,
    absPath: resolved,
  }
}

/**
 * Compile one workspace-relative glob. `**` crosses directories; `*` and `?`
 * stay inside one segment. `**\/` also matches zero directories.
 * @param pattern - glob pattern using forward slashes.
 * @param caseInsensitive - whether matching ignores case.
 * @returns the compiled regular expression.
 */
export function globToRegExp(pattern, caseInsensitive = false) {
  const normalized = String(pattern).replaceAll('\\', '/')
  // A pattern without a slash matches at any depth, like a gitignore basename rule.
  let source = normalized.includes('/') ? '^' : '^(?:.*/)?'
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]
    if (character === '*') {
      if (normalized[index + 1] === '*') {
        if (normalized[index + 2] === '/') {
          source += '(?:.*/)?'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (character === '?') {
      source += '[^/]'
      continue
    }
    source += /[\\^$+.()|{}[\]]/u.test(character) ? `\\${character}` : character
  }
  return new RegExp(`${source}$`, caseInsensitive ? 'i' : '')
}

/**
 * Format the model-facing block reason with its remediation choices.
 * @param conflict - the recorded overlap.
 * @returns the reason text.
 */
export function blockReason(conflict) {
  return [
    `Session tripwire blocked this write (${TRIPWIRE_CONFLICT}).`,
    `${conflict.path} is held by session ${conflict.otherSessionId ?? 'unknown'} `
      + `(writer ${conflict.otherWriterId}, fence ${conflict.otherFence}).`,
    `Lease expires ${new Date(conflict.otherExpiresAt).toISOString()}. `
      + `Last recorded hash: ${conflict.currentHash ?? 'none'}.`,
    `Remediation: re-read ${conflict.path} and retry with the current content; `
      + `take ownership with /tripwire claim ${conflict.path}; `
      + `or stand down and let the holder finish.`,
  ].join('\n')
}

/**
 * Format the warning appended to an allowed write result.
 * @param conflict - the recorded overlap.
 * @param write - the completed write record, when available.
 * @returns the warning text.
 */
export function warningText(conflict, write = undefined) {
  const change = write === undefined
    ? 'The write completed.'
    : `The write replaced hash ${shortHash(write.beforeHash)} with ${shortHash(write.hash)}.`
  return [
    `Tripwire warning (write allowed): ${conflict.path} is also held by session `
      + `${conflict.otherSessionId ?? 'unknown'} (writer ${conflict.otherWriterId}, fence ${conflict.otherFence}).`,
    change,
    `Re-read ${conflict.path} before further edits, or stand down so the other session keeps its work.`,
  ].join('\n')
}

/**
 * Format a hash for display.
 * @param hash - full hex hash or null.
 * @returns the first twelve characters, or `none`.
 */
export function shortHash(hash) {
  return typeof hash === 'string' && hash !== '' ? hash.slice(0, 12) : 'none'
}

/** Empty persisted state. */
function emptyState(now) {
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    killSwitch: false,
    mode: 'observe',
    nextFence: 1,
    writers: {},
    leases: {},
    writes: {},
    fences: {},
    released: {},
    conflicts: [],
    ignore: [],
    ignoreRemoved: [],
    expiredLeases: [],
    bypasses: [],
  }
}

/** Apply one journal entry to a state, used only when the snapshot is missing. */
function applyJournalEntry(state, type, data) {
  switch (type) {
    case 'writer/register':
      state.writers[data.writer.id] = data.writer
      break
    case 'writer/offline': {
      const writer = state.writers[data.writerId]
      if (writer !== undefined) {
        writer.live = false
        writer.lastSeenAt = data.at
      }
      break
    }
    case 'lease/claim':
      state.leases[data.lease.key] = data.lease
      state.fences[data.lease.key] = Math.max(state.fences[data.lease.key] ?? 0, data.lease.fence)
      state.nextFence = Math.max(state.nextFence, data.lease.fence + 1)
      break
    case 'lease/release':
      state.released[data.key] = Number.isFinite(data.fence) ? data.fence : (state.fences[data.key] ?? 0)
      delete state.leases[data.key]
      break
    case 'lease/expire':
      delete state.leases[data.key]
      break
    case 'write':
      state.writes[data.write.key] = data.write
      if (Number.isFinite(data.write.fence)) {
        state.fences[data.write.key] = Math.max(state.fences[data.write.key] ?? 0, data.write.fence)
        state.nextFence = Math.max(state.nextFence, data.write.fence + 1)
      }
      break
    case 'conflict':
      state.conflicts.unshift(data.conflict)
      state.conflicts = state.conflicts.slice(0, 200)
      break
    case 'config/mode':
      state.mode = data.mode
      break
    case 'config/kill':
      state.killSwitch = data.killSwitch === true
      break
    case 'config/ignore':
      if (data.action === 'add' && !state.ignore.some(entry => entry.pattern === data.pattern)) {
        state.ignore.push({ pattern: data.pattern, addedAt: Date.now() })
        state.ignoreRemoved = state.ignoreRemoved.filter(pattern => pattern !== data.pattern)
      } else if (data.action === 'remove') {
        state.ignore = state.ignore.filter(entry => entry.pattern !== data.pattern)
        if (!state.ignoreRemoved.includes(data.pattern)) state.ignoreRemoved.push(data.pattern)
      }
      break
    default:
      break
  }
}

/** One workspace-scoped write-intent ledger. */
export class TripwireLedger {
  /**
   * @param options - ledger configuration.
   */
  constructor(options = {}) {
    if (typeof options.root !== 'string' || options.root.trim() === '') {
      throw new TripwireError('session-tripwire: root must be a non-empty absolute path', 'BAD_ROOT')
    }
    this.root = path.resolve(options.root)
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = positiveInteger(options.ttlMs, 120_000)
    this.mode = MODES.includes(options.mode) ? options.mode : 'observe'
    this.maxConflicts = positiveInteger(options.maxConflicts, 200)
    this.dir = path.join(this.root, '.dsh', 'tripwire')
    this.statePath = path.join(this.dir, 'state.json')
    this.journalPath = path.join(this.dir, 'journal.jsonl')
    this.state = emptyState(this.now())
    this.state.mode = this.mode
    this.defaultIgnore = options.ignore ?? DEFAULT_IGNORE
    this.matchers = new Map()
    for (const pattern of this.defaultIgnore) this.#addIgnoreEntry(pattern, this.state.createdAt)
    this.opened = false
    this.queue = Promise.resolve()
  }

  /**
   * Load the snapshot, or replay the journal when the snapshot is unusable.
   * @returns this ledger after initialization.
   */
  async open() {
    if (this.opened) return this
    await fs.mkdir(this.dir, { recursive: true })
    let loaded = false
    try {
      const raw = await fs.readFile(this.statePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && parsed.version === 1) {
        this.state = { ...emptyState(this.now()), ...parsed }
        loaded = true
      }
    } catch {
      loaded = false
    }
    if (!loaded) {
      const replayed = await this.#replayJournal()
      if (replayed) {
        this.state = replayed
        for (const pattern of this.defaultIgnore) {
          if (this.state.ignore.some(entry => entry.pattern === pattern)) continue
          if (this.state.ignoreRemoved.includes(pattern)) continue
          this.#addIgnoreEntry(pattern, this.state.createdAt)
        }
      }
      await this.#writeSnapshot()
    }
    this.matchers.clear()
    this.#prune(this.now())
    this.opened = true
    return this
  }

  /**
   * Register or refresh one Session writer.
   * @param input - writer identity and workspace facts.
   * @returns the stored writer record.
   */
  async registerWriter(input) {
    await this.open()
    const now = this.now()
    const sessionId = String(input.sessionId ?? 'unknown')
    const id = input.writerId ?? writerIdFor(sessionId, input.agentId, input.pid)
    const existing = this.state.writers[id]
    const writer = existing === undefined
      ? {
        id,
        sessionId,
        agentId: input.agentId === undefined ? null : String(input.agentId),
        pid: input.pid ?? process.pid,
        cwd: input.cwd ?? this.root,
        label: input.label ?? null,
        startedAt: now,
        lastSeenAt: now,
        live: true,
      }
      : {
        ...existing,
        cwd: input.cwd ?? existing.cwd,
        label: input.label ?? existing.label,
        lastSeenAt: now,
        live: true,
      }
    this.state.writers[id] = writer
    await this.#persist('writer/register', { writer })
    return writer
  }

  /**
   * Mark a writer offline without releasing its leases. A crashed or closed
   * writer still holds a lease until its TTL expires.
   * @param writerId - writer to retire.
   * @returns whether the writer was known.
   */
  async markOffline(writerId) {
    await this.open()
    const writer = this.state.writers[writerId]
    if (writer === undefined) return false
    writer.live = false
    writer.lastSeenAt = this.now()
    await this.#persist('writer/offline', { writerId, at: writer.lastSeenAt })
    return true
  }

  /**
   * Refresh a writer's liveness timestamp.
   * @param writerId - writer to refresh.
   * @returns whether the writer was known.
   */
  async heartbeat(writerId) {
    await this.open()
    const writer = this.state.writers[writerId]
    if (writer === undefined) return false
    writer.lastSeenAt = this.now()
    writer.live = true
    await this.#writeSnapshot()
    return true
  }

  /**
   * Check and reserve intent for one write.
   * @param input - writer, target, tool name, and optional mode override.
   * @returns the allow/warn/block decision with its lease and conflict.
   */
  async beginWrite(input) {
    await this.open()
    const normalized = normalizePath(this.root, input.absPath, this.platform)
    if (normalized === null) {
      return { action: 'allow', ignored: true, outside: true, path: String(input.absPath) }
    }
    const { key, display, absPath } = normalized
    if (this.#isIgnored(key, display)) {
      return { action: 'allow', ignored: true, outside: false, path: display, key }
    }
    if (this.state.killSwitch) {
      this.state.bypasses.push({ at: this.now(), writerId: input.writerId, key, path: display, tool: input.tool ?? null })
      this.state.bypasses = this.state.bypasses.slice(-50)
      await this.#writeSnapshot()
      return { action: 'allow', bypass: 'kill-switch', path: display, key }
    }

    // Hash before the ownership check. The check and the lease acquisition then
    // run in one synchronous turn, so two concurrent intents cannot both win.
    const before = await hashFile(absPath)
    const now = this.now()
    this.#prune(now)
    const sessionId = String(input.sessionId ?? this.#sessionOf(input.writerId))
    this.#ensureWriter(input.writerId, sessionId, input.cwd)
    const effectiveMode = MODES.includes(input.mode) ? input.mode : this.state.mode
    const lease = this.state.leases[key]
    const active = lease !== undefined && lease.expiresAt > now
    let conflict = null
    if (active && lease.owner !== input.writerId) {
      const previous = this.state.writes[key]
      conflict = {
        id: `cf_${randomUUID()}`,
        at: now,
        kind: 'overlap',
        mode: effectiveMode,
        key,
        path: display,
        writerId: input.writerId,
        writerSessionId: sessionId,
        otherWriterId: lease.owner,
        otherSessionId: lease.sessionId ?? null,
        otherFence: lease.fence,
        otherExpiresAt: lease.expiresAt,
        currentHash: previous?.hash ?? null,
        previousWriterId: previous?.writerId ?? null,
        decision: null,
      }
    }

    if (conflict !== null && effectiveMode === 'block') {
      conflict.decision = 'blocked'
      this.#rememberConflict(conflict)
      await this.#persist('conflict', { conflict })
      return {
        action: 'block',
        path: display,
        key,
        conflict,
        reason: blockReason(conflict),
        info: { name: 'TripwireConflict', code: TRIPWIRE_CONFLICT, reason: blockReason(conflict) },
      }
    }

    // Observe is log-only: record the overlap and let the write proceed without
    // taking the current holder's lease.
    const observeOnly = conflict !== null && effectiveMode === 'observe'
    let acquired = null
    let acquiredNew = false
    if (!observeOnly) {
      const existingLease = this.state.leases[key]
      acquiredNew = existingLease === undefined || existingLease.owner !== input.writerId || existingLease.expiresAt <= now
      acquired = this.#acquire(key, display, input.writerId, sessionId, now)
    }
    if (conflict !== null) {
      conflict.decision = observeOnly ? 'observed' : effectiveMode === 'warn' ? 'warned' : 'observed'
      if (acquired !== null) conflict.fence = acquired.fence
      this.#rememberConflict(conflict)
    }
    await this.#persist('intent', {
      intent: {
        at: now,
        writerId: input.writerId,
        sessionId,
        key,
        path: display,
        tool: input.tool ?? null,
        mode: effectiveMode,
        fence: acquired?.fence ?? null,
        conflictId: conflict?.id ?? null,
      },
    })
    if (conflict !== null) await this.#appendJournal('conflict', { conflict })
    if (acquiredNew && acquired !== null) await this.#appendJournal('lease/claim', { lease: acquired })
    return {
      action: conflict === null ? 'allow' : effectiveMode === 'warn' ? 'warn' : 'allow',
      observeOnly,
      path: display,
      key,
      absPath,
      lease: acquired ?? undefined,
      acquiredNew,
      conflict,
      beforeHash: before?.hash ?? null,
      warning: conflict === null || observeOnly ? null : warningText(conflict),
    }
  }

  /**
   * Record a completed write and refresh its lease.
   * @param input - writer, target, fence, tool, and optional precomputed hash.
   * @returns the stored write record, or a stale-owner result.
   */
  async recordWrite(input) {
    await this.open()
    const normalized = normalizePath(this.root, input.absPath, this.platform)
    if (normalized === null) return { ignored: true, stale: false }
    const { key, display, absPath } = normalized
    if (this.#isIgnored(key, display)) return { ignored: true, stale: false }

    const now = this.now()
    this.#prune(now)
    const sessionId = String(input.sessionId ?? this.#sessionOf(input.writerId))
    this.#ensureWriter(input.writerId, sessionId, input.cwd)

    // Observe-mode writes do not own the lease; record the bytes and the hash
    // without changing who holds the path.
    if (input.preserveLease === true) {
      const snapshot = input.hash === undefined || input.hash === null
        ? await hashFile(absPath)
        : { hash: input.hash, bytes: input.bytes ?? null, mtimeMs: input.mtimeMs ?? null }
      const write = {
        key,
        path: display,
        writerId: input.writerId,
        sessionId,
        hash: snapshot?.hash ?? null,
        beforeHash: input.beforeHash ?? null,
        bytes: snapshot?.bytes ?? null,
        mtimeMs: snapshot?.mtimeMs ?? null,
        at: now,
        tool: input.tool ?? null,
        fence: null,
        changed: (input.beforeHash ?? null) !== (snapshot?.hash ?? null),
        preservedLease: true,
      }
      this.state.writes[key] = write
      await this.#persist('write', { write })
      return { write, stale: false, ignored: false, preserved: true }
    }

    const lease = this.state.leases[key]
    const hadLease = lease !== undefined
    const floor = this.state.fences[key]
    const releasedFence = this.state.released[key]
    const fenceFloorHit = input.fence !== undefined && input.fence !== null
      && floor !== undefined && input.fence < floor
    const releasedHit = lease === undefined && input.fence !== undefined && input.fence !== null
      && releasedFence !== undefined && input.fence === releasedFence
    const stale = (lease !== undefined && lease.owner !== input.writerId) || fenceFloorHit || releasedHit
    if (stale) {
      const holder = lease ?? {
        key,
        path: display,
        owner: 'unknown',
        sessionId: null,
        fence: floor,
        expiresAt: 0,
      }
      const conflict = {
        id: `cf_${randomUUID()}`,
        at: now,
        kind: 'stale-write',
        mode: this.state.mode,
        key,
        path: display,
        writerId: input.writerId,
        writerSessionId: sessionId,
        otherWriterId: holder.owner,
        otherSessionId: holder.sessionId ?? null,
        otherFence: holder.fence,
        otherExpiresAt: holder.expiresAt ?? 0,
        currentHash: this.state.writes[key]?.hash ?? null,
        decision: 'stale',
      }
      this.#rememberConflict(conflict)
      await this.#persist('conflict', { conflict })
      return { stale: true, ignored: false, holder, conflict }
    }

    const current = this.#acquire(key, display, input.writerId, sessionId, now)
    let snapshot
    if (input.hash === undefined || input.hash === null) {
      snapshot = await hashFile(absPath)
      const after = this.state.leases[key]
      if (after === undefined || after.owner !== input.writerId || after.fence !== current.fence) {
        const holder = after ?? {
          key,
          path: display,
          owner: 'unknown',
          sessionId: null,
          fence: this.state.fences[key] ?? current.fence,
          expiresAt: 0,
        }
        const conflict = {
          id: `cf_${randomUUID()}`,
          at: now,
          kind: 'stale-write',
          mode: this.state.mode,
          key,
          path: display,
          writerId: input.writerId,
          writerSessionId: sessionId,
          otherWriterId: holder.owner,
          otherSessionId: holder.sessionId ?? null,
          otherFence: holder.fence,
          otherExpiresAt: holder.expiresAt ?? 0,
          currentHash: this.state.writes[key]?.hash ?? null,
          decision: 'stale',
        }
        this.#rememberConflict(conflict)
        await this.#persist('conflict', { conflict })
        return { stale: true, ignored: false, holder, conflict }
      }
    } else {
      snapshot = { hash: input.hash, bytes: input.bytes ?? null, mtimeMs: input.mtimeMs ?? null }
    }
    const write = {
      key,
      path: display,
      writerId: input.writerId,
      sessionId,
      hash: snapshot?.hash ?? null,
      beforeHash: input.beforeHash ?? null,
      bytes: snapshot?.bytes ?? null,
      mtimeMs: snapshot?.mtimeMs ?? null,
      at: now,
      tool: input.tool ?? null,
      fence: current.fence,
      changed: (input.beforeHash ?? null) !== (snapshot?.hash ?? null),
    }
    this.state.writes[key] = write
    current.writeCount = (current.writeCount ?? 0) + 1
    current.updatedAt = now
    current.expiresAt = now + this.ttlMs
    await this.#persist('write', { write })
    if (!hadLease) await this.#appendJournal('lease/claim', { lease: current })
    return { write, stale: false, ignored: false }
  }

  /**
   * Take ownership of a path, fencing out any previous holder.
   * @param input - writer, target, optional TTL, and reason.
   * @returns the new lease.
   */
  async claim(input) {
    await this.open()
    const normalized = normalizePath(this.root, input.absPath, this.platform)
    if (normalized === null) throw new TripwireError(`${String(input.absPath)} is outside the workspace`, 'OUTSIDE_WORKSPACE')
    const now = this.now()
    this.#prune(now)
    this.#ensureWriter(input.writerId, String(input.sessionId ?? this.#sessionOf(input.writerId)), input.cwd)
    const lease = this.#acquire(normalized.key, normalized.display, input.writerId, input.sessionId, now, true, input.ttlMs)
    lease.reason = input.reason ?? 'manual-claim'
    await this.#persist('lease/claim', { lease })
    return lease
  }

  /**
   * Release one path.
   * @param input - writer, target, and whether to override ownership.
   * @returns whether a lease was removed.
   */
  async release(input) {
    await this.open()
    const normalized = normalizePath(this.root, input.absPath, this.platform)
    if (normalized === null) return { released: false, reason: 'outside' }
    const lease = this.state.leases[normalized.key]
    if (lease === undefined) return { released: false, reason: 'unheld' }
    if (lease.owner !== input.writerId && input.force !== true) {
      throw new TripwireError(`${normalized.display} is held by ${lease.owner}`, 'NOT_OWNER')
    }
    delete this.state.leases[normalized.key]
    this.state.released[normalized.key] = lease.fence
    await this.#persist('lease/release', { key: normalized.key, by: input.writerId, fence: lease.fence })
    return { released: true, lease }
  }

  /**
   * Set the workspace enforcement mode.
   * @param mode - observe, warn, or block.
   * @returns the stored mode.
   */
  async setMode(mode) {
    await this.open()
    if (!MODES.includes(mode)) throw new TripwireError(`unknown mode ${String(mode)}`, 'BAD_MODE')
    this.state.mode = mode
    await this.#persist('config/mode', { mode })
    return mode
  }

  /**
   * Enable or disable the global kill switch.
   * @param enabled - whether every write bypasses the tripwire.
   * @returns the stored value.
   */
  async setKillSwitch(enabled) {
    await this.open()
    this.state.killSwitch = enabled === true
    await this.#persist('config/kill', { killSwitch: this.state.killSwitch })
    return this.state.killSwitch
  }

  /**
   * Add one ignore pattern.
   * @param pattern - workspace-relative glob.
   * @returns the stored pattern.
   */
  async ignore(pattern) {
    await this.open()
    const clean = this.#cleanPattern(pattern)
    if (!this.state.ignore.some(entry => entry.pattern === clean)) {
      this.#addIgnoreEntry(clean, this.now())
      this.state.ignoreRemoved = this.state.ignoreRemoved.filter(entry => entry !== clean)
      await this.#persist('config/ignore', { pattern: clean, action: 'add' })
    }
    return clean
  }

  /**
   * Remove one ignore pattern.
   * @param pattern - exact stored pattern.
   * @returns whether it was present.
   */
  async unignore(pattern) {
    await this.open()
    const clean = this.#cleanPattern(pattern)
    const present = this.state.ignore.some(entry => entry.pattern === clean)
    if (present) {
      this.state.ignore = this.state.ignore.filter(entry => entry.pattern !== clean)
      if (!this.state.ignoreRemoved.includes(clean)) this.state.ignoreRemoved.push(clean)
      await this.#persist('config/ignore', { pattern: clean, action: 'remove' })
    }
    return present
  }

  /**
   * Read the complete panel snapshot.
   * @param options - optional limit overrides.
   * @returns the serializable board state.
   */
  async status(options = {}) {
    await this.open()
    const now = this.now()
    const changed = this.#prune(now)
    if (changed) await this.#writeSnapshot()
    const writers = Object.values(this.state.writers)
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
      .map(writer => ({ ...writer }))
    const leases = Object.values(this.state.leases)
      .sort((left, right) => left.expiresAt - right.expiresAt)
      .map(lease => ({ ...lease }))
    const writes = Object.values(this.state.writes)
      .sort((left, right) => right.at - left.at)
      .slice(0, options.maxWrites ?? 100)
      .map(write => ({ ...write }))
    const conflicts = this.state.conflicts.slice(0, options.maxConflicts ?? 50).map(entry => ({ ...entry }))
    const active = leases.filter(lease => lease.expiresAt > now)
    return {
      version: 1,
      root: this.root,
      mode: this.state.mode,
      killSwitch: this.state.killSwitch,
      updatedAt: this.state.updatedAt,
      writers,
      leases,
      writes,
      conflicts,
      ignore: this.state.ignore.map(entry => ({ ...entry })),
      expiredLeases: this.state.expiredLeases.slice(-20).map(entry => ({ ...entry })),
      bypasses: this.state.bypasses.slice(-20).map(entry => ({ ...entry })),
      stats: {
        writers: writers.length,
        liveWriters: writers.filter(writer => writer.live).length,
        leases: leases.length,
        activeLeases: active.length,
        writes: Object.keys(this.state.writes).length,
        conflicts: this.state.conflicts.length,
      },
    }
  }

  /** Resolve a model-supplied path against the workspace root. */
  resolve(pathValue) {
    return path.resolve(this.root, pathValue)
  }

  /** Flush queued state writes. */
  async close() {
    await this.queue
  }

  /** Add one ignore entry if the pattern is non-empty. */
  #addIgnoreEntry(pattern, at) {
    if (typeof pattern !== 'string') return
    const clean = pattern.trim().replaceAll('\\', '/')
    if (clean === '') return
    this.state.ignore.push({ pattern: clean, addedAt: at })
    this.matchers.clear()
  }

  /** Validate and normalize one ignore pattern. */
  #cleanPattern(pattern) {
    const clean = String(pattern ?? '').trim().replaceAll('\\', '/').replace(/^\.\//u, '')
    if (clean === '') throw new TripwireError('ignore pattern must not be empty', 'BAD_PATTERN')
    if (clean.length > 200) throw new TripwireError('ignore pattern is longer than 200 characters', 'BAD_PATTERN')
    return clean
  }

  /** Whether one path is ignored by configuration or is internal ledger state. */
  #isIgnored(key, display) {
    if (key.startsWith(INTERNAL_PREFIX)) return true
    const lowered = this.platform === 'win32'
    for (const entry of this.state.ignore) {
      const cached = this.matchers.get(entry.pattern)
      const matcher = cached ?? globToRegExp(entry.pattern, lowered)
      if (cached === undefined) this.matchers.set(entry.pattern, matcher)
      if (matcher.test(display) || matcher.test(key)) return true
    }
    return false
  }

  /** Ensure a writer record exists for a tool call whose Session was not announced. */
  #ensureWriter(writerId, sessionId, cwd) {
    if (writerId === undefined || this.state.writers[writerId] !== undefined) return
    const now = this.now()
    this.state.writers[writerId] = {
      id: writerId,
      sessionId,
      agentId: null,
      pid: Number(String(writerId).split(':').at(-1)) || process.pid,
      cwd: cwd ?? this.root,
      label: 'auto-registered',
      startedAt: now,
      lastSeenAt: now,
      live: true,
    }
  }

  /** Derive a Session id from a writer id. */
  #sessionOf(writerId) {
    return String(writerId ?? 'unknown').split(':')[0]
  }

  /** Create or extend one lease. */
  #acquire(key, display, writerId, sessionId, now, forceNewFence = false, ttlMs = undefined) {
    const existing = this.state.leases[key]
    if (existing !== undefined && existing.owner === writerId && forceNewFence !== true) {
      existing.updatedAt = now
      existing.expiresAt = now + (ttlMs ?? this.ttlMs)
      return existing
    }
    const lease = {
      key,
      path: display,
      owner: writerId,
      sessionId: sessionId ?? this.#sessionOf(writerId),
      fence: this.state.nextFence,
      acquiredAt: now,
      updatedAt: now,
      expiresAt: now + (ttlMs ?? this.ttlMs),
      writeCount: 0,
    }
    this.state.nextFence += 1
    this.state.leases[key] = lease
    this.state.fences[key] = lease.fence
    return lease
  }

  /** Drop expired leases and return whether anything changed. */
  #prune(now) {
    let changed = false
    for (const [key, lease] of Object.entries(this.state.leases)) {
      if (lease.expiresAt > now) continue
      delete this.state.leases[key]
      this.state.expiredLeases.push({ key, path: lease.path, owner: lease.owner, fence: lease.fence, expiresAt: lease.expiresAt, at: now })
      changed = true
    }
    if (this.state.expiredLeases.length > 100) this.state.expiredLeases = this.state.expiredLeases.slice(-100)
    return changed
  }

  /** Record a conflict in memory, bounded. */
  #rememberConflict(conflict) {
    this.state.conflicts.unshift(conflict)
    if (this.state.conflicts.length > this.maxConflicts) this.state.conflicts.length = this.maxConflicts
  }

  /** Persist state and append one journal entry. */
  async #persist(type, data) {
    await this.#writeSnapshot()
    await this.#appendJournal(type, data)
  }

  /** Atomically replace the snapshot, serialized against other saves. */
  #writeSnapshot() {
    const task = async () => {
      this.state.updatedAt = this.now()
      const temporary = `${this.statePath}.${process.pid}.tmp`
      await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
      await fs.rename(temporary, this.statePath)
    }
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => {})
    return run
  }

  /** Append one journal line, serialized after the snapshot. */
  #appendJournal(type, data) {
    const task = async () => {
      const entry = { v: 1, at: this.now(), type, data }
      await fs.appendFile(this.journalPath, `${JSON.stringify(entry)}\n`, 'utf8')
    }
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => {})
    return run
  }

  /** Rebuild state from the journal when the snapshot is missing. */
  async #replayJournal() {
    let raw
    try {
      raw = await fs.readFile(this.journalPath, 'utf8')
    } catch {
      return null
    }
    const state = emptyState(this.now())
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const entry = JSON.parse(line)
        if (entry !== null && typeof entry === 'object' && typeof entry.type === 'string') {
          applyJournalEntry(state, entry.type, entry.data ?? {})
        }
      } catch {
        // A torn final line is expected after a crash; earlier lines remain valid.
      }
    }
    state.mode = MODES.includes(state.mode) ? state.mode : 'observe'
    return state
  }
}

/** Coerce a positive integer option. */
function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
