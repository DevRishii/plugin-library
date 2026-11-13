/** Path normalization, exclusion rules, and SHA-256 helpers shared by the receipt engine. */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** File-tree segments never listed unless the caller opts in. */
export const DEFAULT_EXCLUDES = Object.freeze(['node_modules', '.git'])

/**
 * Convert a host path to slash-separated form.
 * @param {string} value - any path.
 * @returns {string} the path with `/` separators.
 */
export function toPosix(value) {
  return value.split(sep).join('/')
}

/**
 * Resolve one session-relative or absolute path against the working directory.
 * @param {string} cwd - session working directory.
 * @param {string} value - path from a tool argument.
 * @returns {string} an absolute path.
 */
export function absolutePath(cwd, value) {
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value)
}

/**
 * The display form of a file: relative inside the workspace, `~` under home, absolute otherwise.
 * @param {string} cwd - session working directory.
 * @param {string} absolute - absolute file path.
 * @param {string} [home] - home directory override.
 * @returns {string} a slash-separated display path.
 */
export function displayPath(cwd, absolute, home = homedir()) {
  const rel = relative(cwd, absolute)
  if (!rel.startsWith('..') && !isAbsolute(rel)) return toPosix(rel) || '.'
  const homeRel = relative(home, absolute)
  if (!homeRel.startsWith('..') && !isAbsolute(homeRel)) return `~/${toPosix(homeRel)}`
  return toPosix(absolute)
}

/**
 * Whether a display path contains an excluded segment.
 * @param {string} display - slash-separated display path.
 * @param {readonly string[]} excludes - segment names to drop.
 * @returns {boolean} true when any segment matches.
 */
export function isExcluded(display, excludes = DEFAULT_EXCLUDES) {
  if (excludes.length === 0) return false
  const segments = display.split('/')
  return segments.some(segment => excludes.includes(segment))
}

/**
 * Compare two display paths by segment, case-insensitively on the file name.
 * @param {string} left - first path.
 * @param {string} right - second path.
 * @returns {number} sort order.
 */
export function comparePaths(left, right) {
  return left.localeCompare(right, 'en', { sensitivity: 'base' })
}

/**
 * Hash a buffer.
 * @param {Buffer|string} value - bytes or UTF-8 text.
 * @returns {string} lowercase hex SHA-256.
 */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Hash a file's bytes in a stream.
 * @param {string} file - absolute file path.
 * @returns {Promise<string>} lowercase hex SHA-256.
 */
export async function sha256File(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

/**
 * Whether a path is a regular file.
 * @param {string} file - absolute file path.
 * @returns {boolean} existence as a file.
 */
export function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Byte length of an existing file.
 * @param {string} file - absolute file path.
 * @returns {number} size in bytes, or 0 when absent.
 */
export function fileBytes(file) {
  return existsSync(file) ? statSync(file).size : 0
}
