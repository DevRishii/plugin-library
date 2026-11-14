#!/usr/bin/env node
/**
 * GitHub PR transport for the Hivemind /pr-review swarm.
 *
 * Three zero-dependency modes:
 *   1. Fixture directory (offline, deterministic)
 *   2. Primary HTTPS REST API via an injectable fetch implementation
 *   3. `gh` CLI fallback using argv arrays only (never a shell string)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ContractError,
  ERROR_CODES,
  EXIT_CODES,
  parsePrRef
} from './contracts.mjs'

const USER_AGENT = 'hivemind-pr-review/0.1.0'
const DEFAULT_API_BASE = 'https://api.github.com'
const DEFAULT_TIMEOUT_MS = 20000

function resolvePrRef(input) {
  if (typeof input === 'string') return parsePrRef(input)
  if (input && typeof input === 'object') {
    if (typeof input.canonical_url === 'string' && input.canonical_url) {
      return parsePrRef(input.canonical_url)
    }
    if (typeof input.short_ref === 'string' && input.short_ref) {
      return parsePrRef(input.short_ref)
    }
    if (input.owner && input.repo && input.number) {
      return parsePrRef(`${input.owner}/${input.repo}#${input.number}`)
    }
  }
  throw new ContractError(
    ERROR_CODES.INVALID_PR_REF,
    'fetchGitHubPRData requires a parsed PR ref or a PR reference string'
  )
}

function timeoutSignal(options) {
  const raw = Number(options.timeoutMs)
  const ms = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS
  return AbortSignal.timeout(ms)
}

function buildHeaders(options, accept) {
  const headers = {
    Accept: accept,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28'
  }
  const token = options.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token && String(token).trim()) {
    headers.Authorization = `Bearer ${String(token).trim()}`
  }
  return headers
}

async function safeFetch(fetchImpl, url, options, accept) {
  try {
    return await fetchImpl(url, {
      headers: buildHeaders(options, accept),
      signal: timeoutSignal(options)
    })
  } catch (error) {
    if (error instanceof ContractError) throw error
    const reason = error && error.message ? error.message : String(error)
    throw new ContractError(
      ERROR_CODES.TRANSPORT_ERROR,
      `GitHub transport error for ${url}: ${reason}`,
      EXIT_CODES.INTERNAL
    )
  }
}

async function readJsonResponse(response) {
  try {
    return await response.json()
  } catch (error) {
    const reason = error && error.message ? error.message : String(error)
    throw new ContractError(
      ERROR_CODES.TRANSPORT_ERROR,
      `Failed to parse GitHub JSON response: ${reason}`,
      EXIT_CODES.INTERNAL
    )
  }
}

async function readTextResponse(response) {
  try {
    return await response.text()
  } catch (error) {
    const reason = error && error.message ? error.message : String(error)
    throw new ContractError(
      ERROR_CODES.TRANSPORT_ERROR,
      `Failed to read GitHub diff response: ${reason}`,
      EXIT_CODES.INTERNAL
    )
  }
}

function authOrFallback(response, options, label) {
  if (response.status !== 401 && response.status !== 403) return false
  if (options.allowGhFallback !== false) return true
  throw new ContractError(
    ERROR_CODES.AUTH_REQUIRED,
    `${label} rejected GitHub credentials (HTTP ${response.status}); set GITHUB_TOKEN or authenticate the gh CLI`,
    EXIT_CODES.NOT_FOUND_OR_REFUSED
  )
}

function ensureSuccess(response, label) {
  if (response.ok) return
  if (response.status === 404) {
    throw new ContractError(
      ERROR_CODES.NOT_FOUND,
      `${label} not found (HTTP 404)`,
      EXIT_CODES.NOT_FOUND_OR_REFUSED
    )
  }
  throw new ContractError(
    ERROR_CODES.TRANSPORT_ERROR,
    `${label} failed with HTTP ${response.status}`,
    EXIT_CODES.INTERNAL
  )
}

async function fetchViaHttp(ref, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new ContractError(
      ERROR_CODES.TRANSPORT_ERROR,
      'No fetch implementation available; pass options.fetchImpl or run on Node >= 18',
      EXIT_CODES.INTERNAL
    )
  }

  const apiBase = String(options.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const prUrl = `${apiBase}/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`
  const commitsUrl = `${prUrl}/commits?per_page=100`
  const jsonAccept = 'application/vnd.github+json'
  const diffAccept = 'application/vnd.github.v3.diff'

  const prResponse = await safeFetch(fetchImpl, prUrl, options, jsonAccept)
  if (prResponse.status === 404) {
    throw new ContractError(
      ERROR_CODES.NOT_FOUND,
      `PR ${ref.short_ref} not found (HTTP 404)`,
      EXIT_CODES.NOT_FOUND_OR_REFUSED
    )
  }
  if (authOrFallback(prResponse, options, `PR ${ref.short_ref}`)) {
    return fetchViaGh(ref, options)
  }
  ensureSuccess(prResponse, `PR ${ref.short_ref}`)
  const pr = await readJsonResponse(prResponse)

  const commitsResponse = await safeFetch(fetchImpl, commitsUrl, options, jsonAccept)
  ensureSuccess(commitsResponse, `PR ${ref.short_ref} commits`)
  const commitsRaw = await readJsonResponse(commitsResponse)
  const commits = Array.isArray(commitsRaw) ? commitsRaw : []

  const diffResponse = await safeFetch(fetchImpl, prUrl, options, diffAccept)
  ensureSuccess(diffResponse, `PR ${ref.short_ref} diff`)
  const rawDiff = await readTextResponse(diffResponse)

  return { pr, files: null, commits, rawDiff, transport_used: 'fetch' }
}

function runGh(args) {
  return spawnSync('gh', args, { shell: false, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function ghFailure(run) {
  if (run.error && run.error.message) return run.error.message
  if (typeof run.stderr === 'string' && run.stderr.trim()) return run.stderr.trim()
  return 'gh CLI is unavailable or returned a non-zero exit code'
}

function fetchViaGh(ref, options) {
  const base = ['api', `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`]

  const prRun = runGh(base)
  if (prRun.error || prRun.status !== 0) {
    throw new ContractError(
      ERROR_CODES.AUTH_REQUIRED,
      `gh CLI fallback failed to load PR ${ref.short_ref}: ${ghFailure(prRun)}`,
      EXIT_CODES.NOT_FOUND_OR_REFUSED
    )
  }

  let pr
  try {
    pr = JSON.parse(prRun.stdout)
  } catch (error) {
    const reason = error && error.message ? error.message : String(error)
    throw new ContractError(
      ERROR_CODES.TRANSPORT_ERROR,
      `gh CLI returned malformed PR JSON: ${reason}`,
      EXIT_CODES.INTERNAL
    )
  }

  let commits = []
  const commitsRun = runGh(['api', `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/commits?per_page=100`])
  if (!commitsRun.error && commitsRun.status === 0) {
    try {
      const parsed = JSON.parse(commitsRun.stdout)
      if (Array.isArray(parsed)) commits = parsed
    } catch {
      commits = []
    }
  }

  const diffRun = runGh([...base, '-H', 'Accept: application/vnd.github.v3.diff'])
  if (diffRun.error || diffRun.status !== 0) {
    throw new ContractError(
      ERROR_CODES.AUTH_REQUIRED,
      `gh CLI fallback failed to load diff for ${ref.short_ref}: ${ghFailure(diffRun)}`,
      EXIT_CODES.NOT_FOUND_OR_REFUSED
    )
  }

  return { pr, files: null, commits, rawDiff: diffRun.stdout, transport_used: 'gh' }
}

function readJsonFixture(dir, name) {
  const fullPath = join(dir, name)
  if (!existsSync(fullPath)) return undefined
  try {
    return JSON.parse(readFileSync(fullPath, 'utf8'))
  } catch (error) {
    const reason = error && error.message ? error.message : String(error)
    throw new ContractError(
      ERROR_CODES.INVALID_INPUT,
      `Invalid JSON in fixture file ${name}: ${reason}`
    )
  }
}

function loadFixture(ref, options) {
  const dir = options.fixtureDir
  const pr = readJsonFixture(dir, 'pr.json')
  if (!pr) {
    throw new ContractError(
      ERROR_CODES.NOT_FOUND,
      `Fixture directory is missing pr.json for ${ref.short_ref}`,
      EXIT_CODES.NOT_FOUND_OR_REFUSED
    )
  }

  const diffPath = join(dir, 'diff.patch')
  if (!existsSync(diffPath)) {
    throw new ContractError(
      ERROR_CODES.NOT_FOUND,
      `Fixture directory is missing diff.patch for ${ref.short_ref}`,
      EXIT_CODES.NOT_FOUND_OR_REFUSED
    )
  }

  const rawDiff = readFileSync(diffPath, 'utf8')
  const files = readJsonFixture(dir, 'files.json') ?? null
  const commits = readJsonFixture(dir, 'commits.json') ?? []

  return {
    pr,
    files: Array.isArray(files) ? files : null,
    commits: Array.isArray(commits) ? commits : [],
    rawDiff,
    transport_used: 'fixture'
  }
}

/**
 * Load the PR JSON, commit list, and unified diff for a PR reference.
 *
 * @param {string|object} prRef Parsed PR ref or a supported PR reference string.
 * @param {object} [options] Transport options.
 * @returns {Promise<{ pr: object, files: Array<object>|null, commits: Array<object>, rawDiff: string, transport_used: 'fixture'|'fetch'|'gh' }>}
 */
export async function fetchGitHubPRData(prRef, options = {}) {
  const ref = resolvePrRef(prRef)

  if (options.fixtureDir) {
    return loadFixture(ref, options)
  }
  if (options.transport === 'gh') {
    return fetchViaGh(ref, options)
  }
  return fetchViaHttp(ref, options)
}

export default fetchGitHubPRData