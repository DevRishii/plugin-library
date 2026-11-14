#!/usr/bin/env node
/**
 * Deterministic, lens-aware diff slicer for the `/pr-review` swarm.
 *
 * A large PR must never be dumped into every specialist prompt. This module
 * ranks hunks by how much signal they carry for a specific review lens and
 * packs the highest-signal hunks into a line budget. Ranking is pure and
 * deterministic: score descending, then original hunk order. The same packet
 * and lens always produce the same slice.
 *
 * Shared constants, the lens registry, quarantine helpers, and packet
 * validation are imported from the architect-owned contracts module. Nothing
 * here redefines those contracts.
 */
import {
  SCHEMA_VERSION,
  ERROR_CODES,
  BUDGETS,
  LENS_BY_ID,
  ContractError,
  estimateTokens,
  partitionLensesIntoWaves,
  validatePRContextPacket
} from './contracts.mjs'

/**
 * Internal marker attached to a copy of a file entry so the standalone
 * scorer can tell whether a changed source file has a matching test change.
 * Kept on a Symbol so it can never collide with packet data or leak into JSON.
 */
const TEST_GAP = Symbol('prReview.testGap')

const TEST_PATH_RE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/i

const HUNK_PATH_KEYS = ['file_path', 'filePath', 'filename', 'path', 'file']

function toPosix(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

function normalizePath(value) {
  return toPosix(value).replace(/^\.\//, '').replace(/^\/+/, '')
}

function readPath(entry) {
  if (!entry || typeof entry !== 'object') return ''
  for (const key of HUNK_PATH_KEYS) {
    const value = entry[key]
    if (typeof value === 'string' && value.trim()) return normalizePath(value)
  }
  if (entry.from && typeof entry.from === 'string') return normalizePath(entry.from)
  if (entry.to && typeof entry.to === 'string') return normalizePath(entry.to)
  return ''
}

function readLineContent(line) {
  if (typeof line === 'string') {
    if (line.length > 0 && /^[+\-\\ ]/.test(line)) return line.slice(1)
    return line
  }
  if (!line || typeof line !== 'object') return ''
  const value = line.content ?? line.text ?? line.value ?? line.code ?? line.raw ?? ''
  return typeof value === 'string' ? value : String(value)
}

function readLineType(line) {
  const raw = typeof line === 'string' ? line : line?.type ?? line?.kind ?? line?.op ?? ''
  const value = String(raw ?? '').toLowerCase()
  if (typeof line === 'string' && line.length > 0) {
    if (line.startsWith('+')) return 'add'
    if (line.startsWith('-')) return 'del'
    if (line.startsWith('\\')) return 'meta'
    return 'context'
  }
  if (['add', 'added', 'insert', 'insertion', '+'].includes(value)) return 'add'
  if (['del', 'delete', 'deleted', 'remove', 'removal', '-'].includes(value)) return 'del'
  if (['meta', 'note', 'no_newline', '\\'].includes(value)) return 'meta'
  return 'context'
}

function readCoordinate(line, keys) {
  if (!line || typeof line !== 'object') return null
  for (const key of keys) {
    const value = line[key]
    if (Number.isInteger(value) && value > 0) return value
    if (typeof value === 'string' && /^[0-9]+$/.test(value) && Number(value) > 0) {
      return Number(value)
    }
  }
  return null
}

function lineOldCoordinate(line) {
  return readCoordinate(line, ['old_line', 'oldLine', 'old_line_number', 'old_number', 'oldLineNumber'])
}

function lineNewCoordinate(line) {
  return readCoordinate(line, ['new_line', 'newLine', 'new_line_number', 'new_number', 'newLineNumber'])
}

function readInteger(value) {
  if (Number.isInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value)
  return null
}


function hunkLineCount(hunk) {
  if (Array.isArray(hunk?.lines) && hunk.lines.length > 0) return hunk.lines.length
  const explicit = readInteger(hunk?.line_count ?? hunk?.lineCount)
  if (explicit !== null && explicit > 0) return explicit
  const oldLines = readInteger(hunk?.old_lines ?? hunk?.oldLines) ?? 0
  const newLines = readInteger(hunk?.new_lines ?? hunk?.newLines) ?? 0
  return Math.max(1, oldLines + newLines)
}

function hunkSearchText(hunk) {
  const header = typeof hunk?.header === 'string' ? hunk.header : ''
  if (!Array.isArray(hunk?.lines)) return header.toLowerCase()
  const lines = hunk.lines.map((line) => readLineContent(line)).join('\n')
  return `${header}\n${lines}`.toLowerCase()
}

function isTestPath(filePath) {
  return TEST_PATH_RE.test(toPosix(filePath))
}

function baseNameWithoutExtension(filePath) {
  const file = toPosix(filePath).split('/').pop() ?? ''
  return file.replace(/\.[^.]*$/, '').replace(/\.(test|spec)$/i, '')
}

function hasMatchingTestChange(filePath, changedPaths) {
  const normalized = normalizePath(filePath)
  if (isTestPath(normalized)) return true
  const base = baseNameWithoutExtension(normalized).toLowerCase()
  if (!base) return false
  return changedPaths.some((candidate) => {
    const other = normalizePath(candidate)
    return isTestPath(other) && baseNameWithoutExtension(other).toLowerCase() === base
  })
}

function withTestGap(fileEntry, filePath, changedPaths) {
  const source = fileEntry && typeof fileEntry === 'object' ? fileEntry : {}
  return {
    ...source,
    path: normalizePath(source.path ?? filePath),
    [TEST_GAP]: !hasMatchingTestChange(filePath, changedPaths)
  }
}

function testGapFor(fileEntry) {
  if (!fileEntry || typeof fileEntry !== 'object') return false
  if (typeof fileEntry[TEST_GAP] === 'boolean') return fileEntry[TEST_GAP]
  if (typeof fileEntry.has_matching_test === 'boolean') return !fileEntry.has_matching_test
  if (typeof fileEntry.hasMatchingTest === 'boolean') return !fileEntry.hasMatchingTest
  return false
}

function matchesAny(text, terms) {
  let hits = 0
  for (const term of terms) {
    if (text.includes(term)) hits += 1
  }
  return hits
}

function resolveLens(lens) {
  if (typeof lens === 'string') {
    const found = LENS_BY_ID[lens]
    if (!found) {
      throw new ContractError(ERROR_CODES.NOT_FOUND, `Unknown lens: ${lens}`)
    }
    return found
  }
  if (lens && typeof lens === 'object' && typeof lens.id === 'string') {
    const found = LENS_BY_ID[lens.id]
    if (!found) {
      throw new ContractError(ERROR_CODES.NOT_FOUND, `Unknown lens: ${lens.id}`)
    }
    return found
  }
  throw new ContractError(ERROR_CODES.NOT_FOUND, 'Unknown lens: <missing>')
}

/**
 * Keyword tables for the core lenses that do not have a dedicated rule block.
 * Values are combined with the same path/text weighting as the dedicated
 * scorers so no lens is left with an all-zero ranking.
 */
const GENERIC_LENS_TERMS = Object.freeze({
  'feature-team': Object.freeze({
    path: ['src/', 'bin/', 'cli', 'command', 'client', 'ui', 'route'],
    text: ['user', 'error', 'reject', 'throw', 'return', 'workflow', 'state']
  }),
  'polymorphism-dry': Object.freeze({
    path: ['src/', 'lib/'],
    text: ['switch', 'case ', 'if (', 'else if', 'class ', 'function ', 'new ', 'duplicate']
  }),
  'naming-readability': Object.freeze({
    path: ['index', 'lib/', 'util'],
    text: ['const ', 'let ', 'function ', '=>', 'async ', 'await ']
  }),
  'code-style': Object.freeze({
    path: ['src/', 'test/'],
    text: ['console.log', 'debugger', 'todo', 'fixme', 'var ', 'eslint', 'any', '==']
  }),
  'performance-bounds': Object.freeze({
    path: ['src/', 'cli', 'client'],
    text: ['for (', 'while (', '.map(', '.filter(', 'readfilesync', 'buffer', 'json.parse', 'await ', 'fetch(']
  }),
  'observability-resilience': Object.freeze({
    path: ['src/', 'bin/', 'cli'],
    text: ['catch', 'error', 'throw', 'exit', 'finally', 'timeout', 'retry', 'log', 'cleanup']
  })
})

/**
 * Deterministically score a single hunk for one lens.
 *
 * Higher is more relevant. The score is intentionally integer-only so
 * ordering is stable across Node versions and platforms. Path matches are
 * weighted above content matches because a path is a stronger signal of the
 * subsystem a hunk belongs to.
 *
 * @param {object} hunk Diff hunk from `PRContextPacket.hunks`.
 * @param {object} fileEntry Matching entry from `PRContextPacket.files`.
 * @param {string|object} lens Lens id or lens registry object.
 * @returns {number}
 */
export function scoreHunkForLens(hunk, fileEntry, lens) {
  const resolved = resolveLens(lens)
  const filePath = normalizePath(readPath(hunk) || readPath(fileEntry))
  const lowPath = filePath.toLowerCase()
  const lowText = hunkSearchText(hunk)
  const combined = `${lowPath}\n${lowText}`
  const pathHits = (terms) => matchesAny(lowPath, terms)
  const textHits = (terms) => matchesAny(lowText, terms)
  const combinedHits = (terms) => matchesAny(combined, terms)

  let score = 0

  switch (resolved.id) {
    case 'security': {
      const pathTerms = [
        'auth', 'token', 'crypto', 'secret', 'exec', 'spawn', 'fetch', 'path',
        'url', 'cookie', 'input', 'sql', 'prompt', 'sanitize', 'password', 'permission', 'trust'
      ]
      const textTerms = [
        'auth', 'token', 'crypto', 'secret', 'exec(', 'spawn(', 'fetch(', 'cookie',
        'input', 'sql', 'prompt', 'sanitize', 'password', 'permission', 'eval(',
        'innerhtml', 'child_process', 'fs.', 'path.join', 'url('
      ]
      score += pathHits(pathTerms) * 4
      score += textHits(textTerms) * 2
      break
    }
    case 'data-race-conditions': {
      const terms = [
        'async', 'await', 'promise', 'lock', 'lease', 'writefile', 'transaction',
        'state', 'cache', 'queue', 'mutex', 'atomic', 'concurrent', 'race', 'idempot'
      ]
      score += pathHits(terms) * 3
      score += textHits(terms) * 3
      break
    }
    case 'platform-team': {
      if (/\.(ps1|sh|cmd|bat)$/i.test(filePath)) score += 10
      if (/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(filePath)) score += 8
      score += pathHits(['scripts/', '.github/', 'node_modules/', 'install', 'build']) * 5
      score += textHits(['process.', 'os.', 'path.', 'spawn(', 'win32', 'platform', 'env.', '\\r\\n', 'chmod']) * 2
      break
    }
    case 'testing-verification': {
      if (isTestPath(filePath)) {
        score += 12
      } else if (testGapFor(fileEntry)) {
        score += 10
      } else {
        score += 2
      }
      score += textHits(['assert', 'describe(', 'it(', 'test(', 'expect(', 'throws', 'beforeeach', 'aftereach']) * 2
      if (pathHits(['test/', 'tests/', '__tests__/']) > 0) score += 3
      break
    }
    case 'supply-chain-deps': {
      if (/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.npmrc)$/i.test(filePath)) score += 10
      if (/(^|\/)cordis\.patch\.yml$/i.test(filePath)) score += 8
      score += pathHits(['dependencies', 'vendor', 'third_party']) * 4
      score += textHits(['"dependencies"', '"devdependencies"', 'import ', 'require(', 'postinstall']) * 2
      break
    }
    case 'api-contract-compat': {
      score += pathHits(['exports', 'contracts', 'schema', 'cli', 'index', 'bin/', 'api']) * 5
      score += textHits(['export ', 'api', 'schema_version', 'exit code', 'contract', 'interface', 'breaking']) * 2
      break
    }
    case 'intent-alignment': {
      // Intent review needs breadth, not depth: every changed file should get
      // a representative hunk. A small uniform base plus path/size nudges is
      // enough because buildLensSlice interleaves hunks across files.
      score += 5
      score += Math.min(4, Math.floor(hunkLineCount(hunk) / 10))
      score += pathHits(['src/', 'contracts', 'schema', 'cli', 'bin/', 'docs/', 'package.json', '.md']) * 2
      break
    }
    default: {
      const terms = GENERIC_LENS_TERMS[resolved.id]
      if (terms) {
        score += pathHits(terms.path) * 2
        score += textHits(terms.text)
      }
    }
  }

  // Conditional lenses exist only because a trigger file matched. When a hunk
  // touches that trigger, it must outrank incidental files for that lens.
  if (!resolved.always_on && Array.isArray(resolved.triggers) && resolved.triggers.length > 0) {
    const triggerHits = combinedHits(resolved.triggers.map((trigger) => trigger.toLowerCase()))
    if (triggerHits > 0) score += 100 + triggerHits * 5
  }

  return score
}

function interleaveByFile(rankedEntries) {
  const groups = new Map()
  const fileOrder = []
  for (const entry of rankedEntries) {
    const key = entry.filePath || '<unknown>'
    if (!groups.has(key)) {
      groups.set(key, [])
      fileOrder.push(key)
    }
    groups.get(key).push(entry)
  }
  const ordered = []
  let remaining = rankedEntries.length
  while (remaining > 0) {
    for (const key of fileOrder) {
      const group = groups.get(key)
      if (group.length > 0) {
        ordered.push(group.shift())
        remaining -= 1
      }
    }
  }
  return ordered
}

function normalizeMaxLines(rawValue) {
  const value = Number(rawValue ?? BUDGETS.MAX_SLICE_LINES)
  if (!Number.isFinite(value) || value < 1) return BUDGETS.MAX_SLICE_LINES
  // MAX_SLICE_LINES remains the hard upper bound even when a caller asks for
  // a larger budget.
  return Math.min(BUDGETS.MAX_SLICE_LINES, Math.floor(value))
}

function splitIntoPieces(lineEntries, maxHunkLines) {
  const pieces = []
  for (let index = 0; index < lineEntries.length; index += maxHunkLines) {
    pieces.push(lineEntries.slice(index, index + maxHunkLines))
  }
  return pieces
}

/**
 * Expand a source hunk into per-line records that keep the exact OLD/NEW
 * coordinates of every original line. String-only diff fallbacks get explicit
 * coordinates here so downstream renderers never have to infer them after a
 * split.
 */
function expandHunkLines(hunk) {
  const fallbackOldStart = readInteger(hunk?.old_start ?? hunk?.oldStart) ?? 1
  const fallbackNewStart = readInteger(hunk?.new_start ?? hunk?.newStart) ?? 1
  let oldCursor = fallbackOldStart
  let newCursor = fallbackNewStart
  const entries = []
  const rawLines = Array.isArray(hunk?.lines) ? hunk.lines : []

  for (const raw of rawLines) {
    const kind = readLineType(raw)
    let oldLine = lineOldCoordinate(raw)
    let newLine = lineNewCoordinate(raw)
    let oldPos
    let newPos

    if (kind === 'add') {
      oldLine = null
      oldPos = oldCursor
      if (newLine == null) newLine = newCursor
      newPos = newLine
      newCursor = newLine + 1
    } else if (kind === 'del') {
      newLine = null
      newPos = newCursor
      if (oldLine == null) oldLine = oldCursor
      oldPos = oldLine
      oldCursor = oldLine + 1
    } else if (kind === 'meta') {
      oldLine = null
      newLine = null
      oldPos = null
      newPos = null
    } else {
      if (oldLine == null) oldLine = oldCursor
      if (newLine == null) newLine = newCursor
      oldPos = oldLine
      newPos = newLine
      oldCursor = oldLine + 1
      newCursor = newLine + 1
    }

    entries.push({
      kind,
      oldLine,
      newLine,
      oldPos,
      newPos,
      out: toOutputLine(raw, kind, oldLine, newLine)
    })
  }

  return { entries, fallbackOldStart, fallbackNewStart }
}

function toOutputLine(raw, kind, oldLine, newLine) {
  if (typeof raw === 'string') {
    const out = { type: kind, content: readLineContent(raw) }
    if (oldLine != null) out.old_line = oldLine
    if (newLine != null) out.new_line = newLine
    return out
  }
  if (!raw || typeof raw !== 'object') {
    const out = { type: kind, content: readLineContent(raw) }
    if (oldLine != null) out.old_line = oldLine
    if (newLine != null) out.new_line = newLine
    return out
  }

  // Keep the original line object whenever it already carries its explicit
  // coordinates. Only fill in the missing side so source objects are not
  // rewritten or renumbered.
  const hasOld = lineOldCoordinate(raw) != null
  const hasNew = lineNewCoordinate(raw) != null
  const needsOld = oldLine != null && !hasOld
  const needsNew = newLine != null && !hasNew
  if (kind === 'meta' || (!needsOld && !needsNew)) return raw
  return {
    ...raw,
    ...(needsOld ? { old_line: oldLine } : {}),
    ...(needsNew ? { new_line: newLine } : {})
  }
}

function boundedHunkHeader(oldStart, oldLines, newStart, newLines) {
  const header = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`
  return header.length > 160 ? `${header.slice(0, 157)}...` : header
}

const REGENERATED_HUNK_KEYS = new Set([
  'lines',
  'header',
  'old_start', 'oldStart', 'old_lines', 'oldLines',
  'new_start', 'newStart', 'new_lines', 'newLines'
])
const MAX_HUNK_METADATA_VALUE_BYTES = 512

/**
 * Preserve small original hunk identity metadata (id, path, ...) while
 * dropping the unbounded raw patch text and any oversized field that would
 * crowd the fixed slice byte budget. The regenerated coordinate fields and
 * lines always come from the split, never from the source.
 */
function copyHunkMetadata(sourceHunk) {
  const base = {}
  if (!sourceHunk || typeof sourceHunk !== 'object') return base
  for (const [key, value] of Object.entries(sourceHunk)) {
    if (REGENERATED_HUNK_KEYS.has(key) || key === 'raw_patch') continue
    let serialized
    try {
      serialized = JSON.stringify(value)
    } catch {
      continue
    }
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_HUNK_METADATA_VALUE_BYTES) {
      continue
    }
    base[key] = value
  }
  return base
}

function buildOutputHunk(piece, pieceEntries) {
  const first = pieceEntries[0]
  const oldStart = first?.oldPos ?? piece.fallbackOldStart
  const newStart = first?.newPos ?? piece.fallbackNewStart
  let oldLines = 0
  let newLines = 0
  for (const entry of pieceEntries) {
    if (entry.oldLine != null) oldLines += 1
    if (entry.newLine != null) newLines += 1
  }
  return {
    ...copyHunkMetadata(piece.sourceHunk),
    file_path: piece.filePath,
    old_start: oldStart,
    old_lines: oldLines,
    new_start: newStart,
    new_lines: newLines,
    header: boundedHunkHeader(oldStart, oldLines, newStart, newLines),
    lines: pieceEntries.map((entry) => entry.out)
  }
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function fitsSliceBudget(selected, candidate) {
  return serializedBytes(selected.concat([candidate])) <= BUDGETS.MAX_SLICE_BYTES
}

/**
 * Pack ordered source-line pieces into at most `maxLines` retained lines and
 * `BUDGETS.MAX_SLICE_BYTES` serialized bytes. Hunks longer than MAX_HUNK_LINES
 * are split before packing; a single line that cannot fit is omitted whole
 * (never truncated into misleading "complete" evidence).
 */
function packPieces(pieces, maxLines) {
  const selected = []
  let usedLines = 0
  let stopped = false

  for (const piece of pieces) {
    if (stopped) break
    if (piece.entries.length === 0) continue

    let buffer = []
    const flush = () => {
      if (buffer.length === 0) return
      selected.push(buildOutputHunk(piece, buffer))
      buffer = []
    }

    for (const lineEntry of piece.entries) {
      if (usedLines >= maxLines) {
        stopped = true
        break
      }
      if (buffer.length >= BUDGETS.MAX_HUNK_LINES) flush()

      let placed = false
      if (buffer.length < BUDGETS.MAX_HUNK_LINES) {
        const candidate = buildOutputHunk(
          piece,
          [...buffer, lineEntry]
        )
        if (fitsSliceBudget(selected, candidate)) {
          buffer.push(lineEntry)
          usedLines += 1
          placed = true
        }
      }

      if (placed) continue

      flush()
      if (usedLines >= maxLines) {
        stopped = true
        break
      }
      const fresh = buildOutputHunk(
        piece,
        [lineEntry]
      )
      if (fitsSliceBudget(selected, fresh)) {
        buffer = [lineEntry]
        usedLines += 1
      } else if (serializedBytes(selected) + 2 >= BUDGETS.MAX_SLICE_BYTES) {
        // No further hunk can possibly fit; stop scanning the remaining diff.
        stopped = true
        break
      }
      // Otherwise this line is pathological (or currently oversized); omit the
      // whole line and keep trying later lines that may still fit.
    }

    flush()
  }

  return { selected, usedLines, stopped }
}

/**
 * Build a single lens slice from a validated PR context packet.
 *
 * Selected hunks are split into chunks of at most MAX_HUNK_LINES source lines
 * and packed into MAX_SLICE_LINES / MAX_SLICE_BYTES. Truncation is reported
 * honestly whenever any source line is omitted, even if only one hunk was
 * partially selected.
 *
 * @param {object} packet Validated `PRContextPacket`.
 * @param {string} lensId One of the 17 registered lens ids.
 * @param {{ maxLines?: number, maxParallel?: number }} [options]
 * @returns {object}
 */
export function buildLensSlice(packet, lensId, options = {}) {
  validatePRContextPacket(packet)
  const lens = LENS_BY_ID[lensId]
  if (!lens) {
    throw new ContractError(ERROR_CODES.NOT_FOUND, `Unknown lens: ${lensId}`)
  }

  const maxLines = normalizeMaxLines(options.maxLines)
  const files = Array.isArray(packet.files) ? packet.files : []
  const fileByPath = new Map()
  for (const file of files) {
    const filePath = normalizePath(readPath(file))
    if (filePath) fileByPath.set(filePath, file)
  }
  const changedPaths = files.map((file) => normalizePath(readPath(file))).filter(Boolean)

  const ranked = packet.hunks
    .map((hunk, index) => {
      const filePath = normalizePath(readPath(hunk))
      const fileEntry = withTestGap(
        fileByPath.get(filePath) ?? { path: filePath },
        filePath,
        changedPaths
      )
      const expanded = expandHunkLines(hunk)
      return {
        hunk,
        index,
        filePath,
        fileEntry,
        score: scoreHunkForLens(hunk, fileEntry, lens),
        lineEntries: expanded.entries,
        fallbackOldStart: expanded.fallbackOldStart,
        fallbackNewStart: expanded.fallbackNewStart
      }
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)

  const totalSourceLines = ranked.reduce((sum, entry) => sum + entry.lineEntries.length, 0)
  const metadataOnlyHunks = ranked.filter(
    (entry) => entry.lineEntries.length === 0 && hunkLineCount(entry.hunk) > 0
  ).length

  // Flatten each ranked hunk into bounded pieces. Intent alignment uses a fair
  // per-file piece size and interleaves pieces by file, so a giant first hunk
  // cannot crowd every other file out of the breadth-oriented slice.
  const isIntentLens = lens.id === 'intent-alignment'
  const intentFileCount = new Set(ranked.map((entry) => entry.filePath || '<unknown>')).size
  const pieceSize = isIntentLens
    ? Math.max(1, Math.min(BUDGETS.MAX_HUNK_LINES, Math.ceil(maxLines / Math.max(1, intentFileCount))))
    : BUDGETS.MAX_HUNK_LINES

  let pieces = []
  for (const entry of ranked) {
    for (const entries of splitIntoPieces(entry.lineEntries, pieceSize)) {
      pieces.push({
        sourceHunk: entry.hunk,
        filePath: entry.filePath,
        entries,
        fallbackOldStart: entry.fallbackOldStart,
        fallbackNewStart: entry.fallbackNewStart
      })
    }
  }
  if (isIntentLens) pieces = interleaveByFile(pieces)

  const { selected: selectedHunks, usedLines } = packPieces(pieces, maxLines)

  const includedFiles = []
  for (const hunk of selectedHunks) {
    const filePath = normalizePath(readPath(hunk))
    if (filePath && !includedFiles.includes(filePath)) includedFiles.push(filePath)
  }
  const includedSet = new Set(includedFiles)
  const omittedFiles = files
    .map((file) => normalizePath(readPath(file)))
    .filter((filePath) => filePath && !includedSet.has(filePath))

  return {
    schema_version: SCHEMA_VERSION,
    lens,
    pr_ref: packet.pr_ref,
    head_sha: packet.pr_meta.head_sha,
    pr_meta: packet.pr_meta,
    stated_intent: packet.stated_intent,
    file_manifest: files.map((file) => ({
      path: normalizePath(readPath(file)),
      status: file.status ?? 'modified',
      additions: Number.isFinite(file.additions) ? file.additions : 0,
      deletions: Number.isFinite(file.deletions) ? file.deletions : 0
    })),
    total_files_in_pr: files.length,
    included_files: includedFiles,
    omitted_files: omittedFiles,
    hunks: selectedHunks,
    line_count: usedLines,
    estimated_tokens: estimateTokens(JSON.stringify(selectedHunks)),
    truncated: usedLines < totalSourceLines || metadataOnlyHunks > 0,
    omitted_lines: Math.max(0, totalSourceLines - usedLines)
  }
}

function selectedLensId(selection) {
  return typeof selection === 'string' ? selection : selection?.id
}

function buildWaveSliceMetadata(packet, lensId, options) {
  const slice = buildLensSlice(packet, lensId, options)
  return {
    id: slice.lens.id,
    title: slice.lens.title,
    category: slice.lens.category,
    default_agent: slice.lens.default_agent,
    estimated_tokens: slice.estimated_tokens,
    included_files_count: slice.included_files.length,
    truncated: slice.truncated
  }
}

/**
 * Plan parallel dispatch waves for every selected lens.
 *
 * Waves are plain arrays of slice metadata (dispatch order). Each array also
 * exposes non-enumerable `wave` and `slices` aliases for consumers that prefer
 * explicit wave objects; neither alias changes JSON output or deep equality.
 *
 * @param {object} packet Validated `PRContextPacket`.
 * @param {{ maxParallel?: number, maxLines?: number }} [options]
 * @returns {object}
 */
export function buildWaveDispatchPlan(packet, options = {}) {
  validatePRContextPacket(packet)
  const requested = Number(options.maxParallel ?? BUDGETS.DEFAULT_MAX_PARALLEL)
  const maxParallel = Math.max(
    1,
    Math.min(BUDGETS.HARD_MAX_PARALLEL, Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : BUDGETS.DEFAULT_MAX_PARALLEL)
  )
  const lensIds = packet.selected_lenses.map(selectedLensId).filter((id) => typeof id === 'string')

  const waves = partitionLensesIntoWaves(lensIds, maxParallel).map((waveIds, waveIndex) => {
    const slices = waveIds.map((lensId) => buildWaveSliceMetadata(packet, lensId, options))
    Object.defineProperty(slices, 'wave', { value: waveIndex + 1, enumerable: false })
    Object.defineProperty(slices, 'slices', { value: slices, enumerable: false })
    return slices
  })

  return {
    pr_ref: packet.pr_ref,
    head_sha: packet.pr_meta.head_sha,
    max_parallel: maxParallel,
    total_lenses: lensIds.length,
    waves
  }
}
