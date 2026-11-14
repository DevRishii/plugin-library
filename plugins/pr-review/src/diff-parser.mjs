#!/usr/bin/env node
/**
 * Zero-dependency parser for multi-file git unified diffs.
 *
 * Produces normalized file records plus hunk records whose coordinates are
 * safe anchors for GitHub pull-request inline review comments:
 *   - anchorable_new_lines -> RIGHT side (added OR context lines)
 *   - anchorable_old_lines -> LEFT side (deleted OR context lines)
 *
 * `\ No newline at end of file` markers are skipped without advancing either
 * the old or new line counters, so anchor coordinates never drift.
 */
import {
  BUDGETS,
  ContractError,
  ERROR_CODES,
  EXIT_CODES,
  normalizeRepoRelPath,
  sha256Hex
} from './contracts.mjs'

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

function unescapeGitQuoted(value) {
  return String(value).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

function unquoteGitPath(rawPath) {
  const trimmed = String(rawPath).trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapeGitQuoted(trimmed.slice(1, -1))
  }
  return trimmed
}

function parseDiffGitLine(line) {
  const rest = line.slice('diff --git '.length).trim()
  const quoted = /^"a\/(.+?)"\s+"b\/(.+?)"$/.exec(rest)
  if (quoted) {
    return { oldPath: unescapeGitQuoted(quoted[1]), newPath: unescapeGitQuoted(quoted[2]) }
  }
  const plain = /^a\/(.+?) b\/(.+)$/.exec(rest)
  if (plain) {
    return { oldPath: plain[1], newPath: plain[2] }
  }
  return null
}

/**
 * Parse a `--- ` / `+++ ` path value. Returns null for /dev/null so callers can
 * distinguish added and removed files from ordinary modifications.
 */
function parsePathHeader(rawValue) {
  const withoutTimestamp = String(rawValue).split('\t')[0].trim()
  if (withoutTimestamp === '/dev/null') return null
  const unquoted = unquoteGitPath(withoutTimestamp)
  if (unquoted === '/dev/null') return null
  return normalizeRepoRelPath(unquoted.replace(/^[ab]\//, ''))
}

function createFileState(oldPath, newPath) {
  return {
    path: normalizeRepoRelPath(newPath),
    old_path: normalizeRepoRelPath(oldPath),
    status: 'modified',
    is_binary: false,
    additions: 0,
    deletions: 0,
    hunk_ids: [],
    sha256: '',
    _hunkIndex: 0,
    _newAnchors: new Set(),
    _oldAnchors: new Set(),
    _rawChunks: [],
    _oldNull: false,
    _newNull: false
  }
}

function finalizeFile(state) {
  if (state._newNull) {
    state.status = 'removed'
    if (state.old_path) state.path = state.old_path
  } else if (state._oldNull && state.status !== 'renamed') {
    state.status = 'added'
    state.old_path = null
  }

  return {
    path: state.path,
    old_path: state.old_path,
    status: state.status,
    is_binary: state.is_binary,
    additions: state.additions,
    deletions: state.deletions,
    hunk_ids: [...state.hunk_ids],
    anchorable_new_lines: [...state._newAnchors].sort((a, b) => a - b),
    anchorable_old_lines: [...state._oldAnchors].sort((a, b) => a - b),
    sha256: sha256Hex(state._rawChunks.join('\n'))
  }
}

function parseHunkHeader(line, fileState) {
  const match = HUNK_HEADER_RE.exec(line)
  if (!match) {
    throw new ContractError(ERROR_CODES.INVALID_INPUT, `Malformed hunk header: ${line}`)
  }
  const oldStart = Number.parseInt(match[1], 10)
  const oldLines = match[2] === undefined ? 1 : Number.parseInt(match[2], 10)
  const newStart = Number.parseInt(match[3], 10)
  const newLines = match[4] === undefined ? 1 : Number.parseInt(match[4], 10)
  const index = fileState._hunkIndex
  fileState._hunkIndex += 1

  return {
    id: `${fileState.path}#H${index}`,
    path: fileState.path,
    header: line,
    old_start: oldStart,
    old_lines: oldLines,
    new_start: newStart,
    new_lines: newLines,
    raw_patch: line,
    lines: []
  }
}

/**
 * Parse a git unified diff into { files, hunks }.
 *
 * @param {string} rawDiffText Raw `git diff` / GitHub `.diff` payload.
 * @returns {{ files: Array<object>, hunks: Array<object> }}
 */
export function parseUnifiedDiff(rawDiffText) {
  if (typeof rawDiffText !== 'string') {
    throw new ContractError(ERROR_CODES.INVALID_INPUT, 'Unified diff payload must be a string')
  }

  const byteLength = Buffer.byteLength(rawDiffText, 'utf8')
  if (byteLength > BUDGETS.MAX_DIFF_BYTES) {
    throw new ContractError(
      ERROR_CODES.BUDGET_EXCEEDED,
      `Unified diff is ${byteLength} bytes, exceeding MAX_DIFF_BYTES (${BUDGETS.MAX_DIFF_BYTES})`,
      EXIT_CODES.VALIDATION
    )
  }

  const lines = rawDiffText.split('\n')
  const files = []
  const hunks = []
  let fileState = null

  const flushFile = () => {
    if (!fileState) return
    files.push(finalizeFile(fileState))
    fileState = null
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    if (line.startsWith('diff --git ')) {
      flushFile()
      const parsed = parseDiffGitLine(line)
      if (!parsed) {
        throw new ContractError(ERROR_CODES.INVALID_INPUT, `Malformed diff header: ${line}`)
      }
      fileState = createFileState(parsed.oldPath, parsed.newPath)
      continue
    }

    if (!fileState) continue

    if (line.startsWith('@@ ')) {
      const hunk = parseHunkHeader(line, fileState)
      const rawLines = []
      let oldLine = hunk.old_start
      let newLine = hunk.new_start
      let consumedOld = 0
      let consumedNew = 0
      let j = i + 1

      while (j < lines.length) {
        const contentLine = lines[j]

        // `\ No newline at end of file` markers never advance counters.
        if (contentLine.startsWith('\\')) {
          j += 1
          continue
        }

        if (consumedOld >= hunk.old_lines && consumedNew >= hunk.new_lines) break
        if (contentLine.startsWith('diff --git ') || contentLine.startsWith('@@ ')) break

        let type = null
        if (contentLine.startsWith('+')) type = 'add'
        else if (contentLine.startsWith('-')) type = 'del'
        else if (contentLine === '' || contentLine.startsWith(' ')) type = 'ctx'
        else break

        if (type === 'add') {
          hunk.lines.push({ type, old_line: null, new_line: newLine, content: contentLine.slice(1) })
          fileState._newAnchors.add(newLine)
          newLine += 1
          consumedNew += 1
          fileState.additions += 1
        } else if (type === 'del') {
          hunk.lines.push({ type, old_line: oldLine, new_line: null, content: contentLine.slice(1) })
          fileState._oldAnchors.add(oldLine)
          oldLine += 1
          consumedOld += 1
          fileState.deletions += 1
        } else {
          hunk.lines.push({ type, old_line: oldLine, new_line: newLine, content: contentLine.slice(1) })
          fileState._newAnchors.add(newLine)
          fileState._oldAnchors.add(oldLine)
          oldLine += 1
          newLine += 1
          consumedOld += 1
          consumedNew += 1
        }

        rawLines.push(contentLine)
        j += 1
      }

      hunk.raw_patch = rawLines.length > 0 ? `${line}\n${rawLines.join('\n')}` : line
      hunks.push(hunk)
      fileState.hunk_ids.push(hunk.id)
      fileState._rawChunks.push(hunk.raw_patch)
      i = j - 1
      continue
    }

    if (line.startsWith('new file mode')) {
      fileState.status = 'added'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      fileState.status = 'removed'
      continue
    }
    if (line.startsWith('rename from ')) {
      fileState.status = 'renamed'
      fileState.old_path = normalizeRepoRelPath(unquoteGitPath(line.slice('rename from '.length)))
      continue
    }
    if (line.startsWith('rename to ')) {
      fileState.status = 'renamed'
      fileState.path = normalizeRepoRelPath(unquoteGitPath(line.slice('rename to '.length)))
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      fileState.is_binary = true
      continue
    }
    if (line.startsWith('--- ')) {
      const oldPath = parsePathHeader(line.slice(4))
      if (oldPath === null) {
        fileState._oldNull = true
        fileState.old_path = null
      } else {
        fileState.old_path = oldPath
      }
      continue
    }
    if (line.startsWith('+++ ')) {
      const newPath = parsePathHeader(line.slice(4))
      if (newPath === null) {
        fileState._newNull = true
      } else {
        fileState.path = newPath
      }
      continue
    }
    if (line.startsWith('\\')) continue
  }

  flushFile()
  return { files, hunks }
}

export default parseUnifiedDiff