/**
 * Durable-session reader for the receipt engine.
 *
 * DeepSeek Harness writes `session.v4.jsonl.zstd` as a run of independent zstd
 * frames, one per append, so a single `zstdDecompressSync` call returns only
 * the first event. This module walks the frame headers, decompresses each frame,
 * and concatenates the JSONL payload. It is dependency-free on purpose: the
 * receipt CLI must run from a plain `node` without the Harness build.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** zstd frame magic number, little-endian on disk. */
const ZSTD_MAGIC = 0xfd2fb528
/** Skippable-frame magic range: 0x184D2A50..0x184D2A5F. */
const SKIPPABLE_MASK = 0xfffffff0
const SKIPPABLE_BASE = 0x184d2a50

/**
 * Find the end offset of the zstd frame starting at `offset`.
 * @param {Buffer} buffer - file bytes.
 * @param {number} offset - first byte of the frame.
 * @returns {number} the offset just past the frame.
 */
export function frameEnd(buffer, offset) {
  if (buffer.length < offset + 5) throw new Error(`truncated zstd frame header at ${offset}`)
  if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`no zstd frame at ${offset}`)
  let cursor = offset + 4
  const descriptor = buffer[cursor]
  cursor += 1
  const contentSizeFlag = (descriptor >> 6) & 3
  const singleSegment = (descriptor >> 5) & 1
  const hasChecksum = (descriptor >> 2) & 1
  const dictionaryFlag = descriptor & 3
  if (!singleSegment) cursor += 1
  cursor += [0, 1, 2, 4][dictionaryFlag]
  cursor += [singleSegment ? 1 : 0, 2, 4, 8][contentSizeFlag]
  for (;;) {
    if (cursor + 3 > buffer.length) throw new Error(`truncated block header at ${cursor}`)
    const header = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16)
    cursor += 3
    const last = header & 1
    const blockType = (header >> 1) & 3
    const blockSize = header >>> 3
    if (blockType === 0 || blockType === 2) cursor += blockSize
    else if (blockType === 1) cursor += 1
    else throw new Error(`reserved zstd block type at ${cursor}`)
    if (cursor > buffer.length) throw new Error(`zstd block overruns the file at ${cursor}`)
    if (last) break
  }
  if (hasChecksum) cursor += 4
  return cursor
}

/**
 * Decompress a concatenated-frame zstd buffer.
 * @param {Buffer} buffer - frames in file order.
 * @returns {Buffer} the concatenated plaintext.
 */
export function decompressFrames(buffer) {
  const parts = []
  let offset = 0
  while (offset < buffer.length) {
    const lead = buffer.readUInt32LE(offset)
    if (lead === ZSTD_MAGIC) {
      const end = frameEnd(buffer, offset)
      parts.push(zstdDecompressSync(buffer.subarray(offset, end)))
      offset = end
      continue
    }
    if ((lead & SKIPPABLE_MASK) === SKIPPABLE_BASE) {
      offset += 8 + buffer.readUInt32LE(offset + 4)
      continue
    }
    throw new Error(`unexpected zstd magic 0x${lead.toString(16)} at ${offset}`)
  }
  return Buffer.concat(parts)
}

/**
 * Parse one session log buffer into events.
 * @param {Buffer} buffer - decompressed JSONL bytes.
 * @returns {Array<object>} events in file order.
 */
export function parseSessionBuffer(buffer) {
  const text = buffer.toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    events.push(JSON.parse(trimmed))
  }
  return events
}

/**
 * Read only the session header, walking at most the first frames.
 * @param {string} file - `session.v4.jsonl.zstd` path.
 * @returns {object | null} the header event, or null when no frame holds one.
 */
export function readSessionHeader(file) {
  const buffer = readFileSync(file)
  let offset = 0
  let frames = 0
  while (offset < buffer.length && frames < 16) {
    const lead = buffer.readUInt32LE(offset)
    if (lead === ZSTD_MAGIC) {
      const end = frameEnd(buffer, offset)
      const text = zstdDecompressSync(buffer.subarray(offset, end)).toString('utf8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        const event = JSON.parse(trimmed)
        if (event.type === 'session') return event
      }
      offset = end
      frames += 1
      continue
    }
    if ((lead & SKIPPABLE_MASK) === SKIPPABLE_BASE) {
      offset += 8 + buffer.readUInt32LE(offset + 4)
      continue
    }
    break
  }
  return null
}

/**
 * Read one session file.
 * @param {string} file - `session.v4.jsonl.zstd` path.
 * @returns {Array<object>} events in file order.
 */
export function readSessionFile(file) {
  return parseSessionBuffer(decompressFrames(readFileSync(file)))
}

/**
 * Encode a working directory the way the Harness names its session folder.
 * @param {string} cwd - absolute working directory.
 * @returns {string} the `--C-Users-...--` folder name.
 */
export function workspaceSlug(cwd) {
  const body = resolve(cwd).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `--${body}--`
}

/**
 * Root of the Harness session store.
 * @param {string} [home] - home directory override, for tests.
 * @returns {string} the `sessions` directory.
 */
export function sessionStoreRoot(home = homedir()) {
  return join(home, '.dsh', 'sessions')
}

/**
 * List the session logs for one working directory.
 * @param {string} cwd - absolute working directory.
 * @param {{home?: string, storeRoot?: string}} [options] - overrides for tests.
 * @returns {Array<{id: string, file: string, cwd: string, size: number, mtimeMs: number}>} sessions, newest first.
 */
export function listSessions(cwd, options = {}) {
  const root = options.storeRoot ?? sessionStoreRoot(options.home)
  const folder = join(root, workspaceSlug(cwd))
  if (!existsSync(folder)) return []
  const found = []
  for (const entry of readdirSync(folder)) {
    const file = join(folder, entry, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    const stat = statSync(file)
    found.push({ id: entry, file, cwd, size: stat.size, mtimeMs: stat.mtimeMs })
  }
  return found.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

/**
 * Resolve one session by id, log path, or `-` (`latest`).
 * @param {string} selector - session id, absolute log path, `latest`, or `-`.
 * @param {{cwd: string, home?: string, storeRoot?: string}} options - working directory and store overrides.
 * @returns {{id: string, file: string}} the resolved session log.
 */
export function resolveSession(selector, options) {
  if (selector === '-' || selector === 'latest') {
    const [newest] = listSessions(options.cwd, options)
    if (newest === undefined) throw new Error(`no sessions recorded for ${options.cwd}`)
    return { id: newest.id, file: newest.file }
  }
  if (existsSync(selector)) return { id: sessionIdFromFile(selector), file: resolve(selector) }
  const match = listSessions(options.cwd, options).find(session => session.id === selector || session.id === `session-${selector}`)
  if (match !== undefined) return { id: match.id, file: match.file }
  throw new Error(`session not found: ${selector} (looked under ${join(options.storeRoot ?? sessionStoreRoot(options.home), workspaceSlug(options.cwd))})`)
}

/**
 * Recover the session id from a session folder path.
 * @param {string} file - `session.v4.jsonl.zstd` path.
 * @returns {string} the folder name, which is the session id.
 */
export function sessionIdFromFile(file) {
  const parts = resolve(file).split(/[\\/]/)
  const index = parts.lastIndexOf('session.v4.jsonl.zstd')
  return index > 0 ? parts[index - 1] : 'unknown'
}

/**
 * Extract the session header event.
 * @param {Array<object>} events - session events.
 * @returns {object} the header event, or a synthetic empty one.
 */
export function sessionHeader(events) {
  const header = events.find(event => event.type === 'session')
  return header ?? { type: 'session' }
}

/**
 * Extract the last title event's title.
 * @param {Array<object>} events - session events.
 * @returns {string | null} the latest title.
 */
export function sessionTitle(events) {
  let title = null
  for (const event of events) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
  }
  return title
}
