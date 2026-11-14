#!/usr/bin/env node
/**
 * PR ingestion for the Hivemind /pr-review swarm.
 *
 * Pipeline: fetch transport -> parse unified diff -> extract quarantined stated
 * intent -> select lenses -> partition waves -> validated PRContextPacket.
 */
import {
  ContractError,
  ERROR_CODES,
  EXIT_CODES,
  LENS_BY_ID,
  SCHEMA_VERSION,
  parsePrRef,
  partitionLensesIntoWaves,
  quarantineUntrustedText,
  selectLensesForFiles,
  validatePRContextPacket
} from './contracts.mjs'
import { fetchGitHubPRData } from './github-transport.mjs'
import { parseUnifiedDiff } from './diff-parser.mjs'

const MAX_CLAIMS = 30
const MAX_EXCERPT_CHARS = 600
const MAX_CLAIM_CHARS = 240

const HEADING_RE = /^\s{0,3}(#{1,6})\s*(.*?)\s*#*\s*$/
const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/
const PROBLEM_HEADING_RE = /^(?:problem(?:\s+statement)?|motivation|why)\b/i
const SOLUTION_HEADING_RE = /^(?:solution|approach|what\s+changed|changes)\b/i

function collapseWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function toExcerpt(text) {
  const collapsed = collapseWhitespace(text)
  if (!collapsed) return null
  return collapsed.slice(0, MAX_EXCERPT_CHARS)
}

function commitMessage(commit) {
  if (!commit) return ''
  if (typeof commit === 'string') return commit
  if (typeof commit.message === 'string') return commit.message
  if (commit.commit && typeof commit.commit.message === 'string') return commit.commit.message
  return ''
}

function headingName(rawHeading) {
  return String(rawHeading ?? '')
    .replace(/[*_`]/g, '')
    .replace(/[:\s]+$/g, '')
    .trim()
}

function splitHeadingSections(text) {
  const lines = String(text ?? '').split('\n')
  const sections = []
  let current = null

  for (const line of lines) {
    const match = HEADING_RE.exec(line)
    if (match && match[2]) {
      if (current) sections.push(current)
      current = { heading: headingName(match[2]), level: match[1].length, lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) sections.push(current)
  return sections
}

function extractItemTexts(text) {
  const items = []
  const prose = []

  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (HEADING_RE.test(line)) continue
    const bullet = BULLET_RE.exec(line)
    if (bullet) {
      items.push(bullet[1].trim())
      continue
    }
    prose.push(trimmed)
  }

  for (const paragraph of prose) {
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      const trimmed = sentence.trim()
      if (trimmed) items.push(trimmed)
    }
  }
  return items
}

function buildClaims(titleText, problemText, solutionText, bodyText, commitSubjects) {
  const claims = []
  const seen = new Set()
  let sequence = 0

  const add = (source, rawText) => {
    if (claims.length >= MAX_CLAIMS) return
    const text = collapseWhitespace(rawText).replace(/^[-*+]\s+/, '')
    if (text.length < 3) return
    const key = text.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    sequence += 1
    claims.push({
      id: `${source}-${sequence}`,
      source,
      text: text.slice(0, MAX_CLAIM_CHARS)
    })
  }

  add('title', titleText)
  for (const item of extractItemTexts(problemText)) add('problem', item)
  for (const item of extractItemTexts(solutionText)) add('solution', item)
  for (const item of extractItemTexts(bodyText)) add('body', item)
  for (const subject of commitSubjects) add('commit', subject)

  return claims.slice(0, MAX_CLAIMS)
}

/**
 * Extract and quarantine the PR's stated intent and atomic claims.
 *
 * @param {string} titleRaw Raw PR title (untrusted).
 * @param {string} bodyRaw Raw PR body (untrusted Markdown).
 * @param {Array<object|string>} [commitsRaw] Commits or commit messages (untrusted).
 */
export function extractStatedIntent(titleRaw, bodyRaw, commitsRaw = []) {
  const titleQuarantine = quarantineUntrustedText(titleRaw ?? '', 'pr_title')
  const bodyQuarantine = quarantineUntrustedText(bodyRaw ?? '', 'pr_body')
  const commitList = Array.isArray(commitsRaw) ? commitsRaw : []
  const commitQuarantines = commitList.map((commit, index) =>
    quarantineUntrustedText(commitMessage(commit), `commit_${index + 1}`)
  )

  const sanitizedBody = bodyQuarantine.raw_sanitized
  const sections = splitHeadingSections(sanitizedBody)
  const problemSection = sections.find((section) => PROBLEM_HEADING_RE.test(section.heading)) ?? null
  const solutionSection = sections.find((section) => SOLUTION_HEADING_RE.test(section.heading)) ?? null
  const problemText = problemSection ? problemSection.lines.join('\n') : ''
  const solutionText = solutionSection ? solutionSection.lines.join('\n') : ''

  const commitSubjects = commitQuarantines
    .map((quarantine) => {
      return (
        quarantine.raw_sanitized
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line.length > 0) ?? ''
      )
    })
    .filter((subject) => subject.length > 0)

  const claims = buildClaims(
    titleQuarantine.raw_sanitized,
    problemText,
    solutionText,
    sanitizedBody,
    commitSubjects
  )

  return {
    title: titleQuarantine.raw_sanitized,
    body: sanitizedBody,
    title_quarantined: titleQuarantine,
    body_quarantined: bodyQuarantine,
    commits_quarantined: commitQuarantines,
    has_problem_statement: Boolean(problemSection),
    has_solution: Boolean(solutionSection),
    problem_statement_excerpt: toExcerpt(problemText),
    solution_excerpt: toExcerpt(solutionText),
    claims,
    sanitized: {
      title: titleQuarantine.raw_sanitized,
      body: sanitizedBody,
      commits: commitQuarantines.map((quarantine) => quarantine.raw_sanitized)
    },
    quarantined: {
      title: titleQuarantine.fenced,
      body: bodyQuarantine.fenced,
      commits: commitQuarantines.map((quarantine) => quarantine.fenced)
    }
  }
}

function normalizePrRef(prRefInput) {
  if (typeof prRefInput === 'string') return parsePrRef(prRefInput)
  const canonicalUrl = prRefInput && prRefInput.canonical_url
  if (!canonicalUrl) {
    throw new ContractError(
      ERROR_CODES.INVALID_PR_REF,
      'ingestPullRequest requires a PR reference string or an object with canonical_url'
    )
  }
  return parsePrRef(canonicalUrl)
}

function buildSelectedLenses(filePaths, diffExcerpt, options) {
  const only = Array.isArray(options.onlyLenses)
    ? options.onlyLenses.filter((id) => typeof id === 'string' && LENS_BY_ID[id])
    : null

  let selected
  if (only && only.length > 0) {
    selected = [...new Set(only)].map((id) => ({ id, reason: 'only_lens' }))
  } else {
    selected = selectLensesForFiles(filePaths, diffExcerpt)
  }

  const present = new Set(selected.map((lens) => lens.id))
  const extras = Array.isArray(options.extraLenses) ? options.extraLenses : []
  for (const id of extras) {
    if (typeof id === 'string' && LENS_BY_ID[id] && !present.has(id)) {
      selected.push({ id, reason: 'extra_lens' })
      present.add(id)
    }
  }
  return selected
}

/**
 * Fetch, parse, and normalize a PR into a validated PRContextPacket.
 *
 * @param {string|object} prRefInput PR URL/short ref or an object with canonical_url.
 * @param {object} [options] Transport, lens, and wave options.
 */
export async function ingestPullRequest(prRefInput, options = {}) {
  const prRef = normalizePrRef(prRefInput)
  const transport = await fetchGitHubPRData(prRef, options)
  const pr = transport.pr ?? {}
  const commits = Array.isArray(transport.commits) ? transport.commits : []
  const rawDiff = typeof transport.rawDiff === 'string' ? transport.rawDiff : ''

  const { files, hunks } = parseUnifiedDiff(rawDiff)
  const statedIntent = extractStatedIntent(pr.title, pr.body, commits)

  const selectedLenses = buildSelectedLenses(
    files.map((file) => file.path),
    rawDiff.slice(0, 8000),
    options
  )
  const waves = partitionLensesIntoWaves(
    selectedLenses.map((lens) => lens.id),
    options.maxParallel
  )

  const headSha = pr.head && pr.head.sha ? pr.head.sha : options.headSha
  const baseSha = pr.base && pr.base.sha ? pr.base.sha : options.baseSha
  if (!headSha || !baseSha) {
    throw new ContractError(
      ERROR_CODES.SCHEMA_INVALID,
      'PR data is missing head/base SHA required by PRContextPacket',
      EXIT_CODES.VALIDATION
    )
  }

  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0)
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0)

  const packet = {
    schema_version: SCHEMA_VERSION,
    pr_ref: {
      owner: prRef.owner,
      repo: prRef.repo,
      number: prRef.number,
      canonical_url: prRef.canonical_url,
      short_ref: prRef.short_ref
    },
    pr_meta: {
      title: String(pr.title ?? ''),
      author: (pr.user && pr.user.login) || pr.author || null,
      head_sha: String(headSha),
      base_sha: String(baseSha),
      head_ref: (pr.head && pr.head.ref) || null,
      base_ref: (pr.base && pr.base.ref) || null,
      state: pr.state ?? null,
      html_url: pr.html_url ?? prRef.canonical_url,
      additions: Number.isInteger(pr.additions) ? pr.additions : totalAdditions,
      deletions: Number.isInteger(pr.deletions) ? pr.deletions : totalDeletions,
      changed_files: Number.isInteger(pr.changed_files) ? pr.changed_files : files.length
    },
    stated_intent: statedIntent,
    files,
    hunks,
    selected_lenses: selectedLenses,
    waves,
    transport_used: transport.transport_used,
    diff_bytes: Buffer.byteLength(rawDiff, 'utf8')
  }

  return validatePRContextPacket(packet)
}

export default ingestPullRequest