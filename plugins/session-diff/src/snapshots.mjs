/**
 * Pre-write snapshot store and receipt directory layout.
 *
 * The Host plugin captures a file's bytes immediately before the first file
 * tool mutates it. Copies are content-addressed under `objects/`, and an index
 * maps each workspace path to the captures taken for it. The store answers the
 * receipt's before-hash question and provides selective restore. Retention
 * (default 7 days, 500 MB) is enforced on every capture.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { sha256File, sha256 } from './paths.mjs'
import { workspaceSlug } from './session.mjs'

/** Default retained days. */
export const DEFAULT_RETENTION_DAYS = 7
/** Default retained bytes across one session's objects. */
export const DEFAULT_MAX_BYTES = 500 * 1024 * 1024
/** Default per-file capture cap; a larger file gets no snapshot. */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * Root of the receipt store.
 * @param {string} [home] - home directory override.
 * @returns {string} the `receipts` directory.
 */
export function receiptsRoot(home = homedir()) {
  return join(home, '.dsh', 'receipts')
}

/**
 * The per-session receipt directory.
 * @param {string} cwd - session working directory.
 * @param {string} sessionId - session id.
 * @param {{home?: string}} [options] - home override.
 * @returns {string} the directory holding `receipt.json`, renderings, and snapshots.
 */
export function sessionReceiptDir(cwd, sessionId, options = {}) {
  return join(receiptsRoot(options.home), workspaceSlug(cwd), sessionId)
}

/**
 * Resolve a file's capture entry by workspace display path.
 * @param {Array<object>} entries - index entries.
 * @param {string} path - display path.
 * @returns {object | undefined} the earliest capture for that path.
 */
export function earliestCapture(entries, path) {
  return entries.filter(entry => entry.path === path).sort((left, right) => left.capturedAt - right.capturedAt)[0]
}

/**
 * Serialize JSON with a trailing newline, atomically.
 * @param {string} file - target path.
 * @param {unknown} value - JSON value.
 */
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

/**
 * One session's snapshot objects and index.
 */
export class SnapshotStore {
  /**
   * @param {{dir: string, retentionDays?: number, maxBytes?: number, now?: () => number}} options - store directory and bounds.
   */
  constructor(options) {
    this.dir = options.dir
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.now = options.now ?? (() => Date.now())
    this.objectsDir = join(this.dir, 'snapshots', 'objects')
    this.indexFile = join(this.dir, 'snapshots', 'index.json')
    this.chain = Promise.resolve()
  }

  /**
   * Run one mutation after the previous one settled.
   * @param {() => Promise<unknown>} task - queued work.
   * @returns {Promise<unknown>} the task result.
   */
  serial(task) {
    const run = this.chain.then(task, task)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Read the capture index.
   * @returns {{version: number, entries: Array<object>}} the index.
   */
  readIndex() {
    if (!existsSync(this.indexFile)) return { version: 1, entries: [] }
    try {
      const parsed = JSON.parse(readFileSync(this.indexFile, 'utf8'))
      return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] }
    } catch {
      return { version: 1, entries: [] }
    }
  }

  /**
   * Capture a file's bytes once per path, before the first mutation.
   * @param {{absolute: string, path: string, turn: number|null, content?: Buffer}} request - file and turn.
   * @returns {Promise<object|null>} the index entry, or null when the file is absent or already captured.
   */
  capture(request) {
    return this.serial(async () => {
      const index = this.readIndex()
      if (index.entries.some(entry => entry.path === request.path)) return null
      let bytes
      try {
        if (request.content === undefined && statSync(request.absolute).size > this.maxFileBytes) return null
        bytes = request.content ?? readFileSync(request.absolute)
      } catch {
        return null
      }
      const hash = sha256(bytes)
      const object = join(this.objectsDir, hash.slice(0, 2), hash)
      mkdirSync(dirname(object), { recursive: true })
      if (!existsSync(object)) writeFileSync(object, bytes)
      const entry = {
        path: request.path,
        absolute: request.absolute,
        hash,
        bytes: bytes.length,
        capturedAt: this.now(),
        turn: request.turn ?? null,
      }
      index.entries.push(entry)
      writeJson(this.indexFile, index)
      await this.collect(index.entries)
      return entry
    })
  }

  /**
   * The earliest capture for one path.
   * @param {string} path - display path.
   * @returns {object | null} the capture entry.
   */
  before(path) {
    return earliestCapture(this.readIndex().entries, path) ?? null
  }

  /**
   * Read one object's bytes.
   * @param {string} hash - content hash.
   * @returns {Buffer} the stored bytes.
   */
  object(hash) {
    return readFileSync(join(this.objectsDir, hash.slice(0, 2), hash))
  }

  /**
   * Captured entries grouped by path.
   * @returns {Array<{path: string, captures: number, bytes: number}>} one row per path.
   */
  paths() {
    const byPath = new Map()
    for (const entry of this.readIndex().entries) {
      const row = byPath.get(entry.path) ?? { path: entry.path, captures: 0, bytes: 0 }
      row.captures += 1
      row.bytes += entry.bytes
      byPath.set(entry.path, row)
    }
    return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))
  }

  /**
   * Store statistics.
   * @returns {{entries: number, paths: number, bytes: number, objects: number, retentionDays: number, maxBytes: number}} totals.
   */
  stats() {
    const index = this.readIndex()
    const objects = new Map()
    for (const entry of index.entries) objects.set(entry.hash, entry.bytes)
    return {
      entries: index.entries.length,
      paths: new Set(index.entries.map(entry => entry.path)).size,
      bytes: [...objects.values()].reduce((sum, value) => sum + value, 0),
      objects: objects.size,
      retentionDays: this.retentionDays,
      maxBytes: this.maxBytes,
      maxFileBytes: this.maxFileBytes,
    }
  }

  /**
   * Drop expired entries and enforce the byte cap, deleting unreferenced objects.
   * @returns {Promise<{removedEntries: number, removedObjects: number, freedBytes: number}>} the collection result.
   */
  gc() {
    return this.serial(async () => {
      const index = this.readIndex()
      return this.collect(index.entries)
    })
  }

  /**
   * Apply retention to a set of entries and rewrite the index.
   * @param {Array<object>} entries - current entries.
   * @returns {{removedEntries: number, removedObjects: number, freedBytes: number}} what changed.
   */
  collect(entries) {
    const cutoff = this.now() - this.retentionDays * 24 * 60 * 60 * 1000
    let kept = entries.filter(entry => entry.capturedAt >= cutoff)
    const removedEntries = entries.length - kept.length
    const uniqueBytes = new Map()
    for (const entry of kept) uniqueBytes.set(entry.hash, entry.bytes)
    let total = [...uniqueBytes.values()].reduce((sum, value) => sum + value, 0)
    while (total > this.maxBytes && kept.length > 0) {
      kept.sort((left, right) => left.capturedAt - right.capturedAt)
      const removed = kept.shift()
      const stillReferenced = kept.some(entry => entry.hash === removed.hash)
      if (!stillReferenced) {
        uniqueBytes.delete(removed.hash)
        const object = join(this.objectsDir, removed.hash.slice(0, 2), removed.hash)
        if (existsSync(object)) rmSync(object, { force: true })
      }
      total = [...uniqueBytes.values()].reduce((sum, value) => sum + value, 0)
    }
    const referenced = new Set(kept.map(entry => entry.hash))
    let removedObjects = 0
    let freedBytes = 0
    if (existsSync(this.objectsDir)) {
      for (const prefix of readdirSafe(this.objectsDir)) {
        const folder = join(this.objectsDir, prefix)
        if (!statSync(folder).isDirectory()) continue
        for (const name of readdirSafe(folder)) {
          const file = join(folder, name)
          if (referenced.has(name)) continue
          const size = statSync(file).size
          rmSync(file, { force: true })
          removedObjects += 1
          freedBytes += size
        }
      }
    }
    writeJson(this.indexFile, { version: 1, entries: kept })
    return { removedEntries, removedObjects, freedBytes }
  }

  /**
   * Restore one file from its earliest captured state.
   * @param {{absolute: string, path: string, expectedAfterHash?: string|null, force?: boolean, target?: string}} request - file, expected current hash, and overrides.
   * @returns {Promise<{ok: boolean, reason?: string, restoredHash?: string, restoredBytes?: number, target?: string}>} the outcome.
   */
  restore(request) {
    return this.serial(async () => {
      const entry = earliestCapture(this.readIndex().entries, request.path)
      if (entry === null) return { ok: false, reason: `no snapshot for ${request.path}` }
      const target = request.target ?? request.absolute
      if (existsSync(target) && request.force !== true) {
        const current = await sha256File(target)
        if (request.expectedAfterHash !== undefined && request.expectedAfterHash !== null && current !== request.expectedAfterHash) {
          return { ok: false, reason: `refusing to overwrite ${request.path}: the file changed after the receipt (expected ${request.expectedAfterHash}, found ${current}); pass --force` }
        }
        if (request.expectedAfterHash === undefined || request.expectedAfterHash === null) {
          return { ok: false, reason: `refusing to overwrite ${request.path} without an expected receipt hash; pass --force` }
        }
      }
      const bytes = this.object(entry.hash)
      mkdirSync(dirname(target), { recursive: true })
      const temporary = `${target}.${process.pid}.restore`
      writeFileSync(temporary, bytes)
      renameSync(temporary, target)
      return { ok: true, restoredHash: entry.hash, restoredBytes: bytes.length, target }
    })
  }
}

/**
 * Read a directory, returning an empty list when absent.
 * @param {string} folder - directory path.
 * @returns {string[]} entry names.
 */
function readdirSafe(folder) {
  try {
    return readdirSync(folder)
  } catch {
    return []
  }
}
