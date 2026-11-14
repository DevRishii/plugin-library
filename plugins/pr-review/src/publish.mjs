/**
 * GitHub pull-request review publisher.
 *
 * Dry-run by default. Posting requires --post plus --confirm and performs a
 * live head_sha freshness gate and marker-based idempotency gate before the
 * atomic review POST. Self-review refusals from GitHub downgrade once to
 * COMMENT when the verdict is APPROVE or REQUEST_CHANGES.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  ContractError,
  ERROR_CODES,
  EXIT_CODES,
  REVIEW_MARKER,
  parsePrRef,
  validateOrchestratedPRReviewPayload
} from './contracts.mjs'
import { buildGitHubReviewApiBody, renderReviewMarkdown } from './render.mjs'

function writeTextFile(filePath, content) {
  const target = String(filePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

function resolveToken(options) {
  if (options?.token) return String(options.token).trim()
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  if (envToken.trim()) return envToken.trim()
  try {
    const result = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', shell: false, windowsHide: true })
    if (result?.status === 0 && typeof result.stdout === 'string' && result.stdout.trim()) {
      return result.stdout.trim()
    }
  } catch {
    // gh is optional; absence falls through to AUTH_REQUIRED below.
  }
  return ''
}

function isSelfReviewRefusal(message) {
  return /own pull request|Can not approve|Can not request changes/i.test(String(message ?? ''))
}

async function githubRequest(context, method, path, body) {
  const headers = {
    Authorization: `Bearer ${context.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'hivemind-pr-review'
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const init = {
    method,
    headers,
    signal: AbortSignal.timeout(context.timeoutMs ?? 20_000)
  }
  if (body !== undefined) init.body = JSON.stringify(body)

  const response = await context.fetchImpl(`${context.apiBase}${path}`, init)
  const status = Number(response?.status ?? (response?.ok ? 200 : 500))
  let raw = ''
  let json = null
  if (typeof response?.text === 'function') {
    raw = await response.text()
    if (raw) {
      try {
        json = JSON.parse(raw)
      } catch {
        json = null
      }
    }
  } else if (typeof response?.json === 'function') {
    json = await response.json()
    raw = json == null ? '' : JSON.stringify(json)
  }
  const ok = typeof response?.ok === 'boolean' ? response.ok : status >= 200 && status < 300
  if (!ok) {
    const detail = (json && (json.message || json.error)) || raw || `HTTP ${status}`
    const error = new ContractError(
      ERROR_CODES.TRANSPORT_ERROR,
      `${method} ${path} failed (${status}): ${detail}`,
      EXIT_CODES.INTERNAL
    )
    error.status = status
    throw error
  }
  return json
}

export async function publishPRReview(payload, options = {}) {
  // Fail closed before any dry-run write or network call: contract validation
  // rejects stale/legacy APPROVE artifacts whose coverage is incomplete.
  const review = validateOrchestratedPRReviewPayload(payload)
  const markdownBody = review.markdown_body || renderReviewMarkdown(review)
  const mode = options.mode ?? 'dry_run'
  if (mode !== 'dry_run' && mode !== 'post') {
    throw new ContractError(ERROR_CODES.INVALID_INPUT, `Unsupported publish mode: ${mode}`, EXIT_CODES.VALIDATION)
  }

  if (mode === 'dry_run') {
    const plannedBody = buildGitHubReviewApiBody({ ...review, markdown_body: markdownBody })
    if (options.outMarkdownPath) writeTextFile(options.outMarkdownPath, markdownBody)
    if (options.outJsonPath) writeTextFile(options.outJsonPath, `${JSON.stringify(plannedBody, null, 2)}\n`)
    return {
      mode: 'dry_run',
      posted: false,
      verdict: review.verdict,
      effective_event: review.verdict,
      downgraded_self_review: false,
      inline_comments_count: review.inline_comments.length,
      summary_findings_count: review.summary_findings.length,
      review_id: null,
      review_url: null,
      markdown_body: markdownBody
    }
  }

  if (options.confirm !== true) {
    throw new ContractError(
      ERROR_CODES.REFUSED,
      'Posting to GitHub requires both --post and --confirm',
      EXIT_CODES.VALIDATION
    )
  }

  const token = resolveToken(options)
  if (!token) {
    throw new ContractError(
      ERROR_CODES.AUTH_REQUIRED,
      'GITHUB_TOKEN/GH_TOKEN or authenticated gh CLI required to post review',
      EXIT_CODES.NOT_FOUND_OR_REFUSED
    )
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new ContractError(ERROR_CODES.TRANSPORT_ERROR, 'No fetch implementation available to post review', EXIT_CODES.INTERNAL)
  }

  const ref = parsePrRef(review.pr_ref?.canonical_url)
  const apiBase = String(options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '')
  const context = { fetchImpl, apiBase, token, timeoutMs: options.timeoutMs }
  const repoPath = `/repos/${ref.owner}/${ref.repo}`
  const prPath = `${repoPath}/pulls/${ref.number}`

  const livePr = await githubRequest(context, 'GET', prPath)
  const liveHeadSha = livePr?.head?.sha
  if (!liveHeadSha) {
    throw new ContractError(ERROR_CODES.TRANSPORT_ERROR, 'Unable to determine live PR head_sha', EXIT_CODES.INTERNAL)
  }
  if (String(liveHeadSha) !== String(review.head_sha)) {
    throw new ContractError(
      ERROR_CODES.STALE_HEAD_SHA,
      `PR head moved from ${review.head_sha} to ${liveHeadSha}`,
      EXIT_CODES.STALE_HEAD
    )
  }

  const existing = await githubRequest(context, 'GET', `${prPath}/reviews?per_page=100`)
  const reviewList = Array.isArray(existing) ? existing : Array.isArray(existing?.data) ? existing.data : []
  const fingerprint = `head_sha:${review.head_sha}`
  const duplicate = reviewList.some(
    (item) => typeof item?.body === 'string' && item.body.includes(REVIEW_MARKER) && item.body.includes(fingerprint)
  )
  if (duplicate && options.force !== true) {
    throw new ContractError(
      ERROR_CODES.DUPLICATE_REVIEW,
      'Review already posted for this head_sha (pass --force to post anyway)',
      EXIT_CODES.NOT_FOUND_OR_REFUSED
    )
  }

  const readyReview = { ...review, markdown_body: markdownBody }
  let effectiveEvent = review.verdict
  let downgraded = false
  let posted
  try {
    posted = await githubRequest(context, 'POST', `${prPath}/reviews`, buildGitHubReviewApiBody(readyReview))
  } catch (error) {
    if (error?.status === 422 && review.verdict !== 'COMMENT' && isSelfReviewRefusal(error.message)) {
      downgraded = true
      effectiveEvent = 'COMMENT'
      posted = await githubRequest(context, 'POST', `${prPath}/reviews`, buildGitHubReviewApiBody(readyReview, 'COMMENT'))
    } else {
      throw error
    }
  }

  return {
    mode: 'post',
    posted: true,
    verdict: review.verdict,
    effective_event: effectiveEvent,
    downgraded_self_review: downgraded,
    inline_comments_count: review.inline_comments.length,
    summary_findings_count: review.summary_findings.length,
    review_id: posted?.id ?? null,
    review_url: posted?.html_url ?? null,
    markdown_body: markdownBody
  }
}