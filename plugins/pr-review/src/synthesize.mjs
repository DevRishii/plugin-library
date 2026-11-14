#!/usr/bin/env node
/**
 * Evidence verification, cross-lens finding de-duplication, verdict
 * computation, and final payload synthesis for the `/pr-review` swarm.
 *
 * Findings are only ever treated as authoritative when their file path is in
 * the diff, their line anchor falls inside a diff hunk, and their evidence
 * quote appears verbatim (whitespace-insensitive) in that hunk. Anything else
 * is demoted; an unverified finding can NEVER block a merge.
 */
import {
  SCHEMA_VERSION,
  SEVERITY_RANK,
  CONFIDENCE_RANK,
  LENS_BY_ID,
  ContractError,
  ERROR_CODES,
  validatePRContextPacket,
  validateSubagentReviewReport,
  validateOrchestratedPRReviewPayload
} from './contracts.mjs'
import { evaluateIntentAlignment } from './intent.mjs'

const FILE_PATH_FIELDS = ['path', 'file_path', 'filePath', 'file']


const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to', 'of', 'in', 'on', 'at', 'by',
  'with', 'from', 'into', 'onto', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that',
  'these', 'those', 'we', 'our', 'us', 'you', 'your', 'they', 'their', 'them', 'can', 'could', 'should',
  'would', 'will', 'may', 'might', 'must', 'do', 'does', 'did', 'has', 'have', 'had', 'not', 'no', 'yes',
  'so', 'than', 'too', 'very', 'just', 'only', 'also', 'more', 'most', 'less', 'least', 'some', 'any',
  'all', 'each', 'every', 'both', 'either', 'neither', 'when', 'where', 'while', 'why', 'how', 'what',
  'which', 'who', 'whom', 'whose', 'there', 'here', 'now', 'then', 'before', 'after', 'during', 'via', 'per'
])

function asString(value) {
  return typeof value === 'string' ? value : String(value ?? '')
}

function canonicalPath(rawPath) {
  return asString(rawPath).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

function normalizeWhitespace(value) {
  return asString(value).replace(/\s+/g, ' ').trim().toLowerCase()
}

function alphanumericLength(value) {
  return value.replace(/[^a-z0-9]/g, '').length
}

function uniqStrings(values) {
  return [...new Set(values)]
}

function normalizeLine(line, index) {
  if (typeof line === 'string') {
    return { type: 'context', content: line, old_line: null, new_line: null, index }
  }
  if (!line || typeof line !== 'object') {
    return { type: 'context', content: '', old_line: null, new_line: null, index }
  }
  const newLine = line.new_line ?? line.newLine ?? line.newLineNumber ?? line.right_line ?? null
  const oldLine = line.old_line ?? line.oldLine ?? line.oldLineNumber ?? line.left_line ?? null
  let type = asString(line.type ?? line.kind ?? '').toLowerCase()
  if (!type) {
    if (newLine !== null && oldLine === null) type = 'add'
    else if (oldLine !== null && newLine === null) type = 'del'
    else type = 'context'
  }
  if (type === 'added' || type === '+') type = 'add'
  if (type === 'deleted' || type === 'removed' || type === '-') type = 'del'
  if (type === 'unchanged') type = 'context'
  return {
    type,
    content: asString(line.content ?? line.text ?? line.value ?? ''),
    old_line: oldLine === null ? null : Number(oldLine),
    new_line: newLine === null ? null : Number(newLine),
    index
  }
}

function hunksForFile(packet, filePath) {
  const target = canonicalPath(filePath)
  const hunks = []
  for (const hunk of packet?.hunks ?? []) {
    if (!hunk || typeof hunk !== 'object') continue
    const rawPath = FILE_PATH_FIELDS.map((field) => hunk[field]).find((value) => typeof value === 'string')
    if (rawPath !== undefined && canonicalPath(rawPath) === target) hunks.push(hunk)
  }
  const file = (packet?.files ?? []).find((entry) => canonicalPath(entry?.path) === target)
  if (Array.isArray(file?.hunks)) {
    for (const hunk of file.hunks) if (hunk && typeof hunk === 'object') hunks.push(hunk)
  }
  return hunks
}

function linesForFile(packet, filePath) {
  const lines = []
  for (const hunk of hunksForFile(packet, filePath)) {
    const rawLines = Array.isArray(hunk.lines) ? hunk.lines : []
    rawLines.forEach((line, index) => lines.push(normalizeLine(line, index)))
  }
  return lines
}

function hunkTextForFile(packet, filePath) {
  const parts = []
  const file = (packet?.files ?? []).find((entry) => canonicalPath(entry?.path) === canonicalPath(filePath))
  if (typeof file?.raw_patch === 'string') parts.push(file.raw_patch)
  if (typeof file?.patch === 'string') parts.push(file.patch)
  for (const hunk of hunksForFile(packet, filePath)) {
    if (typeof hunk.raw_patch === 'string') parts.push(hunk.raw_patch)
    if (typeof hunk.raw === 'string') parts.push(hunk.raw)
    if (typeof hunk.header === 'string') parts.push(hunk.header)
    for (const line of Array.isArray(hunk.lines) ? hunk.lines : []) {
      const normalized = normalizeLine(line, 0)
      if (normalized.content) parts.push(normalized.content)
    }
  }
  return normalizeWhitespace(parts.join('\n'))
}

function anchorableLine(packet, filePath, side, lineNumber) {
  const number = Number(lineNumber)
  if (!Number.isInteger(number) || number < 1) return false
  const file = (packet?.files ?? []).find((entry) => canonicalPath(entry?.path) === canonicalPath(filePath))
  const explicit = side === 'LEFT'
    ? (file?.anchorable_old_lines ?? file?.anchorable_left_lines)
    : (file?.anchorable_new_lines ?? file?.anchorable_right_lines)
  if (Array.isArray(explicit) && explicit.map(Number).includes(number)) return true
  for (const line of linesForFile(packet, filePath)) {
    const candidate = side === 'LEFT' ? line.old_line : line.new_line
    if (Number(candidate) === number) return true
  }
  return false
}

function quoteAppearsInHunks(quote, hunkText) {
  const normalizedQuote = normalizeWhitespace(quote)
  if (!normalizedQuote) return false
  if (hunkText.includes(normalizedQuote)) return true
  const segments = asString(quote)
    .split(/\r?\n/)
    .map(normalizeWhitespace)
    .filter((segment) => alphanumericLength(segment) >= 8)
  return segments.some((segment) => hunkText.includes(segment))
}

function demoteSeverity(severity) {
  if (severity === 'BLOCKER' || severity === 'HIGH') return 'MEDIUM'
  return severity
}

/**
 * Verify that a finding points at a real diff file, an anchorable line, and a
 * quote that actually appears in the changed hunks.
 *
 * @param {object} packet PRContextPacket
 * @param {object} finding ReviewFinding
 * @returns {{verified: boolean, anchorable: boolean, file_in_diff: boolean, demote_reason: string|null, normalized_finding: object}}
 */
export function verifyFindingEvidence(packet, finding) {
  if (!finding || typeof finding !== 'object') {
    throw new TypeError('verifyFindingEvidence requires a finding object')
  }
  const path = canonicalPath(finding.path)
  const side = finding.side ?? 'RIGHT'
  const lineEnd = Number(finding.line_end ?? finding.line_start)
  const files = Array.isArray(packet?.files) ? packet.files : []
  const file = files.find((entry) => canonicalPath(entry?.path) === path)

  if (!file) {
    return {
      verified: false,
      anchorable: false,
      file_in_diff: false,
      demote_reason: 'path_not_in_diff',
      normalized_finding: { ...finding, path }
    }
  }

  const anchorOk = anchorableLine(packet, path, side, lineEnd)
  const quoteOk = quoteAppearsInHunks(finding.evidence_quote, hunkTextForFile(packet, path))

  if (anchorOk && quoteOk) {
    return {
      verified: true,
      anchorable: true,
      file_in_diff: true,
      demote_reason: null,
      normalized_finding: {
        ...finding,
        path,
        severity: finding.severity,
        verified: true,
        anchorable: true,
        demote_reason: null
      }
    }
  }

  const demoteReason = !anchorOk ? 'line_not_anchorable' : 'quote_mismatch'
  return {
    verified: false,
    anchorable: false,
    file_in_diff: true,
    demote_reason: demoteReason,
    normalized_finding: {
      ...finding,
      path,
      severity: demoteSeverity(finding.severity),
      verified: false,
      anchorable: false,
      demote_reason: demoteReason
    }
  }
}

function tokenizeForSimilarity(text) {
  const source = asString(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
  const tokens = new Set()
  for (const token of source.split(/[^a-z0-9]+/)) {
    if (token.length < 3) continue
    if (/^[0-9]+$/.test(token)) continue
    if (STOPWORDS.has(token)) continue
    tokens.add(token)
  }
  return tokens
}

function jaccardSimilarity(aText, bText) {
  const a = tokenizeForSimilarity(aText)
  const b = tokenizeForSimilarity(bText)
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection += 1
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

function shouldMerge(left, right) {
  const a = left.normalized_finding
  const b = right.normalized_finding
  if (!a || !b) return false
  if (canonicalPath(a.path) !== canonicalPath(b.path)) return false
  if ((a.side ?? 'RIGHT') !== (b.side ?? 'RIGHT')) return false
  const aStart = Number(a.line_start)
  const aEnd = Number(a.line_end ?? a.line_start)
  const bStart = Number(b.line_start)
  const bEnd = Number(b.line_end ?? b.line_start)
  if (![aStart, aEnd, bStart, bEnd].every(Number.isFinite)) return false
  const adjacent = Math.abs(aEnd - bEnd) <= 3
  const overlapping = aStart <= bEnd && bStart <= aEnd
  if (!adjacent && !overlapping) return false
  const quoteA = normalizeWhitespace(a.evidence_quote)
  const quoteB = normalizeWhitespace(b.evidence_quote)
  if (quoteA && quoteA === quoteB) return true
  const similarity = jaccardSimilarity(`${a.title} ${a.body}`, `${b.title} ${b.body}`)
  return similarity >= 0.35
}

function mergeGroup(group) {
  const findings = group.map((entry) => entry.normalized_finding)
  const lensIds = uniqStrings(findings.flatMap((finding) => {
    const lenses = Array.isArray(finding.corroborating_lenses) ? finding.corroborating_lenses : []
    return [...lenses, finding.lens_id].filter(Boolean)
  })).sort()

  let severity = 'NIT'
  let confidence = 'LOW'
  for (const finding of findings) {
    if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[severity]) severity = finding.severity
    if (CONFIDENCE_RANK[finding.confidence] > CONFIDENCE_RANK[confidence]) confidence = finding.confidence
  }
  if (CONFIDENCE_RANK[confidence] === CONFIDENCE_RANK.MEDIUM && lensIds.length >= 2) {
    confidence = 'HIGH'
  }

  const base = findings.reduce(
    (best, finding) => (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[best.severity] ? finding : best),
    findings[0]
  )
  const verified = group.some((entry) => entry.verified === true)
  const anchorable = group.some((entry) => entry.verified === true && entry.anchorable === true)
  const demoteReason = anchorable ? null : (group.find((entry) => entry.demote_reason)?.demote_reason ?? null)
  const lineStarts = findings.map((finding) => Number(finding.line_start)).filter(Number.isFinite)
  const lineEnds = findings.map((finding) => Number(finding.line_end ?? finding.line_start)).filter(Number.isFinite)

  return {
    verified,
    anchorable,
    file_in_diff: true,
    demote_reason: demoteReason,
    normalized_finding: {
      ...base,
      severity,
      confidence,
      line_start: Math.min(...lineStarts),
      line_end: Math.max(...lineEnds),
      verified,
      anchorable,
      demote_reason: demoteReason,
      corroborating_lenses: lensIds
    }
  }
}

/**
 * Merge overlapping findings reported by multiple lenses into one canonical
 * finding, preserving the strongest severity/confidence and lens provenance.
 *
 * @param {Array<object>} verifiedEntries entries from verifyFindingEvidence
 * @returns {Array<object>} canonical verified entries
 */
export function deduplicateFindings(verifiedEntries) {
  const entries = (Array.isArray(verifiedEntries) ? verifiedEntries : [])
    .filter((entry) => entry && entry.normalized_finding)
  const parent = entries.map((_, index) => index)

  const find = (index) => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    while (parent[index] !== root) {
      const next = parent[index]
      parent[index] = root
      index = next
    }
    return root
  }

  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (!shouldMerge(entries[left], entries[right])) continue
      const leftRoot = find(left)
      const rightRoot = find(right)
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
    }
  }

  const groups = new Map()
  entries.forEach((entry, index) => {
    const root = find(index)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(entry)
  })
  return [...groups.values()].map(mergeGroup)
}

function unwrapFinding(entry) {
  return entry && entry.normalized_finding ? entry.normalized_finding : entry
}

/**
 * Deterministic verdict table.
 *
 * @param {Array<object>} findings canonical findings or verified entries
 * @param {object|null} intentReport IntentAlignmentReport
 * @param {{strictApprove?: boolean}} options
 * @returns {'APPROVE'|'COMMENT'|'REQUEST_CHANGES'}
 */
export function computeOverallVerdict(findings, intentReport, options = {}) {
  const list = (Array.isArray(findings) ? findings : []).map(unwrapFinding).filter(Boolean)
  const isVerified = (finding) => finding.verified !== false
  const intentVerdict = intentReport?.verdict ?? null

  if (list.some((finding) => isVerified(finding) && finding.severity === 'BLOCKER')) {
    return 'REQUEST_CHANGES'
  }
  if (list.some((finding) => isVerified(finding) && finding.severity === 'HIGH' && finding.confidence !== 'LOW')) {
    return 'REQUEST_CHANGES'
  }
  if (intentVerdict === 'MISALIGNED') {
    return 'REQUEST_CHANGES'
  }
  if (intentVerdict === 'PARTIAL' || intentVerdict === 'UNDETERMINABLE') {
    return 'COMMENT'
  }
  if (options.strictApprove && list.some((finding) => ['MEDIUM', 'HIGH', 'LOW', 'NIT'].includes(finding.severity))) {
    return 'COMMENT'
  }
  return 'APPROVE'
}

function compareFindings(left, right) {
  const a = unwrapFinding(left)
  const b = unwrapFinding(right)
  const severityDelta = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0)
  if (severityDelta !== 0) return severityDelta
  const confidenceDelta = (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0)
  if (confidenceDelta !== 0) return confidenceDelta
  const aKey = `${canonicalPath(a.path)}:${Number(a.line_end ?? a.line_start)}`
  const bKey = `${canonicalPath(b.path)}:${Number(b.line_end ?? b.line_start)}`
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
}

function lensIdOf(selection) {
  return typeof selection === 'string' ? selection : selection?.id
}

/**
 * Verify, de-duplicate, and synthesize all subagent reports into one payload.
 *
 * @param {object} packet PRContextPacket
 * @param {Array<object>} subagentReports SubagentReviewReport[]
 * @param {{strictApprove?: boolean, renderMarkdown?: Function}} options
 * @returns {object} OrchestratedPRReviewPayload
 */
export function synthesizeReview(packet, subagentReports = [], options = {}) {
  validatePRContextPacket(packet)

  const reports = (Array.isArray(subagentReports) ? subagentReports : []).map((report) => validateSubagentReviewReport(report))
  const headSha = asString(packet.pr_meta?.head_sha).toLowerCase()
  for (const report of reports) {
    if (asString(report.head_sha).toLowerCase() !== headSha) {
      throw new ContractError(
        ERROR_CODES.STALE_HEAD_SHA,
        `Subagent report for lens "${report.lens_id}" reviewed head_sha ${report.head_sha}, expected ${packet.pr_meta?.head_sha}`
      )
    }
  }

  const intentReportSource = reports.find((report) => report.lens_id === 'intent-alignment' && report.intent_alignment)
  const intent = evaluateIntentAlignment(packet, intentReportSource?.intent_alignment ?? null)

  let findingsTotal = 0
  let droppedHallucinated = 0
  const verifiedEntries = []
  for (const report of reports) {
    for (const finding of report.findings) {
      findingsTotal += 1
      const result = verifyFindingEvidence(packet, finding)
      if (result.file_in_diff === false) {
        droppedHallucinated += 1
        continue
      }
      verifiedEntries.push(result)
    }
  }

  const deduped = deduplicateFindings(verifiedEntries)
  const sorted = [...deduped].sort(compareFindings)
  const canonicalFindings = sorted.map((entry) => entry.normalized_finding)
  const inlineComments = sorted
    .filter((entry) => entry.verified === true && entry.anchorable === true)
    .map((entry) => entry.normalized_finding)
  const summaryFindings = sorted
    .filter((entry) => !(entry.verified === true && entry.anchorable === true))
    .map((entry) => entry.normalized_finding)

  const lensCoverage = (packet.selected_lenses ?? []).map((selection) => {
    const lensId = lensIdOf(selection)
    const lensReports = reports.filter((report) => report.lens_id === lensId)
    const count = canonicalFindings.filter((finding) => {
      const lenses = Array.isArray(finding.corroborating_lenses) && finding.corroborating_lenses.length > 0
        ? finding.corroborating_lenses
        : [finding.lens_id]
      return lenses.includes(lensId)
    }).length
    return {
      lens_id: lensId,
      title: LENS_BY_ID[lensId]?.title ?? lensId,
      status: lensReports.length > 0 ? 'completed' : 'missing',
      reviewed: lensReports.length > 0,
      report_count: lensReports.length,
      findings: count,
      findings_count: count
    }
  })

  const verdict = computeOverallVerdict(canonicalFindings, intent, options)
  const draftPayload = {
    schema_version: SCHEMA_VERSION,
    pr_ref: packet.pr_ref,
    head_sha: packet.pr_meta.head_sha,
    base_sha: packet.pr_meta.base_sha,
    verdict,
    intent,
    inline_comments: inlineComments,
    summary_findings: summaryFindings,
    lens_coverage: lensCoverage,
    stats: {
      subagent_reports: reports.length,
      raw_findings: findingsTotal,
      findings_total: findingsTotal,
      findings_reported: canonicalFindings.length,
      verified_inline: inlineComments.length,
      demoted_to_summary: summaryFindings.length,
      deduplicated_merged: verifiedEntries.length - deduped.length,
      findings_deduped: verifiedEntries.length - deduped.length,
      dropped_hallucinated_path: droppedHallucinated,
      selected_lenses: lensCoverage.length
    }
  }
  const markdownBody = typeof options.renderMarkdown === 'function'
    ? asString(options.renderMarkdown(draftPayload))
    : ''

  return validateOrchestratedPRReviewPayload({
    ...draftPayload,
    markdown_body: markdownBody
  })
}

export default synthesizeReview
