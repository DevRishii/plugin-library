#!/usr/bin/env node
/**
 * Intent vs. Code-Intent alignment evaluation for the `/pr-review` swarm.
 *
 * The evaluator is deterministic: it compares stated intent (PR title, body
 * sections, and extracted claims) with the actual changed files and hunk
 * content carried by the PR context packet. An optional subagent override
 * (produced by the `intent-alignment` lens) is merged only after its file
 * paths are re-validated against `packet.files`, so a hallucinated path can
 * never enter the report.
 *
 * Imported contracts are read-only truth from `contracts.mjs`.
 */
import { validateIntentAlignmentReport } from './contracts.mjs'

const CLAIM_STATUSES = new Set(['covered', 'unfulfilled', 'contradicted'])

const TRIVIAL_TITLE_RE = /^(?:untitled|wip|draft|tmp|temp|update|updates|fix|fixes|changes?|misc|n\/a|na|todo|none|test|testing|[.\-\s_]*)$/i

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to', 'of', 'in', 'on', 'at', 'by',
  'with', 'from', 'into', 'onto', 'over', 'under', 'about', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'it', 'its', 'this', 'that', 'these', 'those', 'we', 'our', 'us', 'i', 'my', 'you', 'your',
  'they', 'their', 'them', 'he', 'she', 'his', 'her', 'can', 'could', 'should', 'would', 'will', 'shall',
  'may', 'might', 'must', 'do', 'does', 'did', 'done', 'has', 'have', 'had', 'not', 'no', 'yes', 'so',
  'than', 'too', 'very', 'just', 'only', 'also', 'more', 'most', 'less', 'least', 'some', 'any', 'all',
  'each', 'every', 'both', 'either', 'neither', 'when', 'where', 'while', 'why', 'how', 'what', 'which',
  'who', 'whom', 'whose', 'there', 'here', 'now', 'then', 'before', 'after', 'during', 'via', 'per',
  'add', 'adds', 'added', 'adding', 'update', 'updates', 'updated', 'updating', 'fix', 'fixes', 'fixed',
  'fixing', 'change', 'changes', 'changed', 'changing', 'refactor', 'refactors', 'refactored', 'bump',
  'bumps', 'bumped', 'improve', 'improves', 'improved', 'support', 'supports', 'supported', 'ensure',
  'ensures', 'ensured', 'use', 'uses', 'used', 'using', 'implement', 'implements', 'implemented',
  'introduce', 'introduces', 'introduced', 'make', 'makes', 'made', 'allow', 'allows', 'allowed',
  'new', 'old', 'file', 'files', 'code', 'please', 'handle', 'handles', 'handled', 'handling',
  'src', 'lib', 'app', 'pkg', 'bin', 'mjs', 'cjs', 'tsx', 'jsx', 'json'
])

const REMOVAL_RE = /\b(remove|removes|removed|removing|delete|deletes|deleted|deleting|drop|drops|dropped|dropping|revert|reverts|reverted|reverting|deprecate|deprecates|deprecated|deprecating|eliminate|eliminates|eliminated|strip|strips|stripped|kill|kills|killed|disable|disables|disabled|no longer)\b/i

const FILE_PATH_FIELDS = ['path', 'file_path', 'filePath', 'file']

function asString(value) {
  return typeof value === 'string' ? value : String(value ?? '')
}

function canonicalPath(rawPath) {
  return asString(rawPath).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/**
 * Split a string into lower-cased alphanumeric tokens (length >= 3) while
 * breaking camelCase and kebab/snake/dot separators. Generic English and
 * software-process words are removed so path/claim overlap is meaningful.
 */
export function tokenizeText(text) {
  const source = asString(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
  const rawTokens = source.split(/[^a-z0-9]+/).filter(Boolean)
  const tokens = []
  for (const token of rawTokens) {
    if (token.length < 3) continue
    if (/^[0-9]+$/.test(token)) continue
    if (STOPWORDS.has(token)) continue
    tokens.push(token)
  }
  return tokens
}

function uniqStrings(values) {
  return [...new Set(values)]
}

function intersectCount(a, b) {
  let count = 0
  for (const token of a) {
    if (b.has(token)) count += 1
  }
  return count
}

function tokenSet(text) {
  return new Set(tokenizeText(text))
}

function isTestOrDocPath(rawPath) {
  const lower = canonicalPath(rawPath).toLowerCase()
  if (/\.(md|mdx|markdown|txt|rst|adoc)$/.test(lower)) return true
  if (/(^|\/)(test|tests|__tests__|spec|specs|docs?|fixtures?|__fixtures__)\//.test(lower)) return true
  if (/\.(test|spec)\.[a-z0-9]+$/.test(lower)) return true
  return false
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

function hunksForFile(packet, file) {
  const target = canonicalPath(file?.path)
  const hunks = []
  for (const hunk of packet?.hunks ?? []) {
    if (!hunk || typeof hunk !== 'object') continue
    const rawPath = FILE_PATH_FIELDS.map((field) => hunk[field]).find((value) => typeof value === 'string')
    if (rawPath !== undefined && canonicalPath(rawPath) === target) hunks.push(hunk)
  }
  if (Array.isArray(file?.hunks)) {
    for (const hunk of file.hunks) if (hunk && typeof hunk === 'object') hunks.push(hunk)
  }
  return hunks
}

function linesForFile(packet, file) {
  const lines = []
  for (const hunk of hunksForFile(packet, file)) {
    const rawLines = Array.isArray(hunk.lines) ? hunk.lines : []
    rawLines.forEach((line, index) => lines.push(normalizeLine(line, index)))
  }
  return lines
}

function normalizedClaims(rawClaims) {
  const claims = []
  const list = Array.isArray(rawClaims) ? rawClaims : []
  list.forEach((raw, index) => {
    const isObject = raw && typeof raw === 'object'
    const text = isObject
      ? asString(raw.text ?? raw.claim ?? raw.statement ?? raw.description)
      : asString(raw)
    if (!text.trim()) return
    const keywords = isObject && Array.isArray(raw.keywords) ? raw.keywords.map(asString) : []
    claims.push({
      claim_id: asString(isObject ? (raw.claim_id ?? raw.id ?? raw.key) : '') || `claim-${index + 1}`,
      text,
      keywords,
      declared_status: isObject && CLAIM_STATUSES.has(asString(raw.status)) ? asString(raw.status) : null
    })
  })
  return claims
}

function sectionFromBody(body, headingPattern) {
  const text = asString(body)
  if (!text.trim()) return ''
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => headingPattern.test(line))
  if (start === -1) return ''
  const collected = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*#{1,6}\s+\S/.test(line)) break
    collected.push(line)
  }
  return collected.join('\n').trim()
}

function structuralIntent(packet) {
  const stated = packet?.stated_intent && typeof packet.stated_intent === 'object' ? packet.stated_intent : {}
  const title = asString(stated.title || packet?.pr_meta?.title || '')
  const body = asString(stated.body || packet?.pr_meta?.body || '')
  const problemStatement = asString(stated.problem_statement ?? sectionFromBody(body, /problem statement/i))
  const solution = asString(stated.solution ?? sectionFromBody(body, /(?:^|\n)\s*(?:##+\s*)?solution\b/i))
  return {
    title,
    body,
    problemStatement,
    solution,
    hasProblemStatement: Boolean(stated.has_problem_statement),
    hasSolution: Boolean(stated.has_solution),
    claims: normalizedClaims(stated.claims)
  }
}

function isRemovalClaim(text) {
  return REMOVAL_RE.test(asString(text))
}

function isAdditionLine(line) {
  return line.type === 'add'
}

function isDeletionLine(line) {
  return line.type === 'del'
}

function claimSubjectTokens(claim) {
  const tokens = tokenSet(`${claim.text} ${claim.keywords.join(' ')}`)
  for (const verb of tokenizeText('remove delete drop revert deprecate eliminate strip kill disable')) {
    tokens.delete(verb)
  }
  return tokens
}

function evaluateClaim(claim, packet, files) {
  const tokens = tokenSet(`${claim.text} ${claim.keywords.join(' ')}`)
  const subjectTokens = claimSubjectTokens(claim)
  const matchedFiles = []
  let sawAddition = false
  let sawDeletionOfSubject = false

  for (const file of files) {
    const pathTokens = tokenSet(file.path)
    const pathHit = intersectCount(subjectTokens, pathTokens) > 0 || intersectCount(tokens, pathTokens) > 0
    let contentHit = false
    for (const line of linesForFile(packet, file)) {
      if (!line.content) continue
      const lineTokens = tokenSet(line.content)
      const subjectHit = intersectCount(subjectTokens, lineTokens) > 0
      if (!subjectHit) continue
      contentHit = true
      if (isAdditionLine(line)) sawAddition = true
      if (isDeletionLine(line)) sawDeletionOfSubject = true
    }
    if (pathHit || contentHit) matchedFiles.push(file.path)
  }

  let status = claim.declared_status
  if (!status) {
    if (isRemovalClaim(claim.text) && matchedFiles.length > 0 && sawAddition && !sawDeletionOfSubject) {
      status = 'contradicted'
    } else {
      status = matchedFiles.length > 0 ? 'covered' : 'unfulfilled'
    }
  }

  return {
    claim_id: claim.claim_id,
    claim: claim.text,
    status,
    matched_files: uniqStrings(matchedFiles)
  }
}

function normalizeClaimStatus(rawStatus) {
  const lower = asString(rawStatus).trim().toLowerCase()
  if (lower === 'covered' || lower === 'fulfilled') return 'covered'
  if (lower === 'unfulfilled' || lower === 'missing' || lower === 'partial') return 'unfulfilled'
  if (lower === 'contradicted') return 'contradicted'
  return null
}

/**
 * A specialist override may only count as evidence when it is a complete,
 * valid IntentAlignmentReport. Empty objects/arrays or partial bodies (for
 * example `{ verdict: "ALIGNED" }`) must be treated as missing data instead
 * of bypassing the requireSpecialist gate.
 */
function validatedSpecialistOverride(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  try {
    return validateIntentAlignmentReport(candidate)
  } catch {
    return null
  }
}

function sanitizeOverride(override, packet) {
  if (!override || typeof override !== 'object') {
    return { verdict: null, mappings: [], scopeCreepFiles: [], extraUnfulfilled: [] }
  }
  const realPaths = new Set(packet.files.map((file) => canonicalPath(file.path)))
  const mappings = []
  const rawMappings = Array.isArray(override.claim_mappings) ? override.claim_mappings : []
  for (const raw of rawMappings) {
    if (!raw || typeof raw !== 'object') continue
    const text = asString(raw.claim ?? raw.claim_text ?? raw.text ?? raw.statement)
    const claimId = asString(raw.claim_id ?? raw.id ?? '')
    if (!claimId && !text) continue
    const rawMatched = raw.matched_files ?? raw.matchedFiles ?? raw.evidence_paths ?? raw.files ?? []
    const matchedFiles = uniqStrings(
      (Array.isArray(rawMatched) ? rawMatched : [])
        .map((entry) => canonicalPath(typeof entry === 'string' ? entry : entry?.path))
        .filter((path) => path && realPaths.has(path))
    )
    let status = normalizeClaimStatus(raw.status)
    if (!status) status = matchedFiles.length > 0 ? 'covered' : 'unfulfilled'
    if (status === 'covered' && matchedFiles.length === 0) status = 'unfulfilled'
    mappings.push({
      claim_id: claimId || `override-${mappings.length + 1}`,
      claim: text,
      status,
      matched_files: matchedFiles
    })
  }
  const rawCreep = Array.isArray(override.scope_creep_files) ? override.scope_creep_files : []
  const scopeCreepFiles = uniqStrings(
    rawCreep
      .map((entry) => canonicalPath(typeof entry === 'string' ? entry : entry?.path))
      .filter((path) => path && realPaths.has(path))
  )
  const rawUnfulfilled = Array.isArray(override.unfulfilled_claims) ? override.unfulfilled_claims : []
  const extraUnfulfilled = uniqStrings(
    rawUnfulfilled.map((entry) => asString(typeof entry === 'string' ? entry : entry?.claim ?? entry?.claim_text ?? entry?.text))
  )
  const rawVerdict = asString(override.verdict).trim().toUpperCase()
  const verdict = ['ALIGNED', 'PARTIAL', 'MISALIGNED', 'UNDETERMINABLE'].includes(rawVerdict) ? rawVerdict : null
  return { verdict, mappings, scopeCreepFiles, extraUnfulfilled }
}

const STATUS_SEVERITY = Object.freeze({
  covered: 0,
  unfulfilled: 1,
  contradicted: 2
})
const SEVERITY_TO_STATUS = Object.freeze(['covered', 'unfulfilled', 'contradicted'])

function mergeClaimMappings(deterministic, override) {
  const merged = deterministic.map((mapping) => ({ ...mapping, matched_files: [...mapping.matched_files] }))
  const indexByKey = new Map()
  merged.forEach((mapping, index) => {
    indexByKey.set(mapping.claim_id, index)
    if (mapping.claim) indexByKey.set(mapping.claim.toLowerCase(), index)
  })
  for (const mapping of override.mappings) {
    const existingIndex = indexByKey.get(mapping.claim_id)
      ?? (mapping.claim ? indexByKey.get(mapping.claim.toLowerCase()) : undefined)
    if (existingIndex !== undefined) {
      const existing = merged[existingIndex]
      const worstRank = Math.max(
        STATUS_SEVERITY[existing.status] ?? 1,
        STATUS_SEVERITY[mapping.status] ?? 1
      )
      existing.status = SEVERITY_TO_STATUS[worstRank]
      if (existing.status === 'covered' && mapping.status === 'covered') {
        existing.matched_files = uniqStrings([...existing.matched_files, ...mapping.matched_files])
      }
      if (existing.status === 'covered' && existing.matched_files.length === 0) existing.status = 'unfulfilled'
      indexByKey.set(existing.claim_id, existingIndex)
      if (existing.claim) indexByKey.set(existing.claim.toLowerCase(), existingIndex)
      continue
    }
    const added = { ...mapping, matched_files: [...mapping.matched_files] }
    Object.defineProperty(added, 'from_override', { value: true, enumerable: false })
    merged.push(added)
    indexByKey.set(mapping.claim_id, merged.length - 1)
    if (mapping.claim) indexByKey.set(mapping.claim.toLowerCase(), merged.length - 1)
  }
  return merged
}

function detectScopeCreep(packet, intent, claimMappings, override) {
  const contextTokens = new Set([
    ...tokenizeText(intent.title),
    ...tokenizeText(intent.body),
    ...tokenizeText(intent.problemStatement),
    ...tokenizeText(intent.solution),
    ...intent.claims.flatMap((claim) => tokenizeText(`${claim.text} ${claim.keywords.join(' ')}`)),
    ...claimMappings.filter((mapping) => !mapping.from_override).flatMap((mapping) => tokenizeText(mapping.claim))
  ])
  if (contextTokens.size === 0) return uniqStrings(override.scopeCreepFiles)
  const creep = []
  for (const file of packet.files) {
    const path = canonicalPath(file.path)
    if (!path) continue
    if (isTestOrDocPath(path)) continue
    const hasDiff = hunksForFile(packet, file).length > 0
      || typeof file.raw_patch === 'string'
      || typeof file.patch === 'string'
      || (Array.isArray(file.anchorable_new_lines) && file.anchorable_new_lines.length > 0)
    if (!hasDiff) continue
    const pathTokens = tokenSet(path)
    if (intersectCount(pathTokens, contextTokens) === 0) creep.push(path)
  }
  for (const path of override.scopeCreepFiles) {
    if (!creep.includes(path)) creep.push(path)
  }
  return uniqStrings(creep)
}

function buildSummary(verdict, intent, claimMappings, unfulfilledClaims, scopeCreepFiles) {
  const covered = claimMappings.filter((mapping) => mapping.status === 'covered').length
  const contradicted = claimMappings.filter((mapping) => mapping.status === 'contradicted').length
  const parts = [
    `Intent alignment verdict: ${verdict}.`,
    `${covered}/${claimMappings.length} claim(s) covered,`,
    `${contradicted} contradicted,`,
    `${unfulfilledClaims.length} unfulfilled,`,
    `${scopeCreepFiles.length} scope-creep file(s).`
  ]
  if (!intent.hasProblemStatement) parts.push('Missing Problem Statement section.')
  if (!intent.hasSolution) parts.push('Missing Solution section.')
  return parts.join(' ')
}

/**
 * Evaluate intent vs. code-intent for a PR context packet.
 *
 * @param {object} packet packet-shaped PRContextPacket
 * @param {object|null} subagentIntentOverride optional intent-alignment report body
 * @param {{requireSpecialist?: boolean}} options
 * @returns {object} validated IntentAlignmentReport
 */
export function evaluateIntentAlignment(packet, subagentIntentOverride = null, options = {}) {
  if (!packet || typeof packet !== 'object') {
    throw new TypeError('evaluateIntentAlignment requires a PR context packet object')
  }

  const specialistOverride = validatedSpecialistOverride(subagentIntentOverride)
  const hasSpecialistData = specialistOverride !== null
  const intent = structuralIntent(packet)
  const files = Array.isArray(packet.files) ? packet.files : []
  const deterministicMappings = intent.claims.map((claim) => evaluateClaim(claim, packet, files))
  // Under requireSpecialist, malformed specialist bodies are ignored entirely
  // so partial/empty payloads cannot inject pseudo-evidence. Outside the gate,
  // preserve the historical best-effort merge of partial override bodies.
  const overrideSource = options.requireSpecialist && !hasSpecialistData ? null : subagentIntentOverride
  const override = sanitizeOverride(overrideSource, packet)
  const claimMappings = mergeClaimMappings(deterministicMappings, override)
  const scopeCreepFiles = detectScopeCreep(packet, intent, claimMappings, override)
  const unfulfilledClaims = claimMappings
    .filter((mapping) => mapping.status === 'unfulfilled' || mapping.status === 'contradicted')
    .map((mapping) => ({
      claim_id: mapping.claim_id,
      claim: mapping.claim,
      status: mapping.status,
      matched_files: mapping.matched_files
    }))
  const existingUnfulfilledTexts = new Set(unfulfilledClaims.map((item) => item.claim.toLowerCase()))
  for (const extraText of override.extraUnfulfilled) {
    if (!existingUnfulfilledTexts.has(extraText.toLowerCase())) {
      existingUnfulfilledTexts.add(extraText.toLowerCase())
      unfulfilledClaims.push({
        claim_id: `override-unfulfilled-${unfulfilledClaims.length + 1}`,
        claim: extraText,
        status: 'unfulfilled',
        matched_files: []
      })
    }
  }

  const coveredCount = claimMappings.filter((mapping) => mapping.status === 'covered' && !mapping.from_override).length
  const contradictedCount = claimMappings.filter((mapping) => mapping.status === 'contradicted').length
  const bodyIsEmpty = !intent.body.trim()
  const titleIsTrivial = !intent.title.trim() || TRIVIAL_TITLE_RE.test(intent.title.trim())
  const hasVerifiedOverrideEvidence =
    override.mappings.some((mapping) => mapping.matched_files.length > 0) ||
    override.scopeCreepFiles.length > 0
  const deterministicUnfulfilledCount = claimMappings.filter(
    (mapping) => !mapping.from_override && (mapping.status === 'unfulfilled' || mapping.status === 'contradicted')
  ).length

  let verdict
  if (titleIsTrivial && bodyIsEmpty && claimMappings.length === 0) {
    verdict = 'UNDETERMINABLE'
  } else if (
    (override.verdict === 'MISALIGNED' && hasVerifiedOverrideEvidence) ||
    contradictedCount > 0 ||
    (deterministicUnfulfilledCount > 0 && coveredCount === 0)
  ) {
    verdict = 'MISALIGNED'
  } else if (
    override.verdict === 'MISALIGNED' ||
    override.verdict === 'PARTIAL' ||
    override.verdict === 'UNDETERMINABLE' ||
    scopeCreepFiles.length > 0 ||
    unfulfilledClaims.length > 0 ||
    (!intent.hasProblemStatement && !intent.hasSolution && files.length > 2)
  ) {
    verdict = override.verdict === 'UNDETERMINABLE' ? 'UNDETERMINABLE' : 'PARTIAL'
  } else {
    verdict = 'ALIGNED'
  }

  // Without valid specialist intent data, lexical heuristics must never
  // certify ALIGNED/PARTIAL. A concrete contradiction may still surface as
  // MISALIGNED, and an explicit non-ALIGNED specialist verdict is respected.
  if (options.requireSpecialist) {
    if (!hasSpecialistData) {
      verdict = contradictedCount > 0 ? 'MISALIGNED' : 'UNDETERMINABLE'
    } else if (verdict === 'ALIGNED' && specialistOverride.verdict !== 'ALIGNED') {
      if (specialistOverride.verdict === 'MISALIGNED') verdict = 'MISALIGNED'
      else if (specialistOverride.verdict === 'UNDETERMINABLE') verdict = 'UNDETERMINABLE'
      else verdict = 'PARTIAL'
    }
  }

  const report = {
    verdict,
    has_problem_statement: intent.hasProblemStatement,
    has_solution: intent.hasSolution,
    claim_mappings: claimMappings,
    scope_creep_files: scopeCreepFiles,
    unfulfilled_claims: unfulfilledClaims,
    summary: buildSummary(verdict, intent, claimMappings, unfulfilledClaims, scopeCreepFiles)
  }
  return validateIntentAlignmentReport(report)
}

export default evaluateIntentAlignment