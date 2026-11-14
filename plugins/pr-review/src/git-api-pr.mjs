/**
 * Pure-Node GitHub Git Data REST API pull-request publisher.
 *
 * Publishes a local directory to a branch without requiring the git or gh
 * binaries. Every network call goes through an injectable fetch implementation.
 * Without a token it writes a deterministic JSON + Markdown publication bundle
 * and refuses with AUTH_REQUIRED rather than fabricating a PR URL.
 */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { ContractError, ERROR_CODES, EXIT_CODES } from './contracts.mjs'

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '.dsh', '.hive'])
const DEFAULT_BRANCH = 'feat/pr-review-swarm'
const DEFAULT_BASE_BRANCH = 'main'
const REQUIRED_BODY_SECTIONS = ['## Problem Statement', '## Solution']

function gitBlobSha(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\0`, 'utf8').update(buffer).digest('hex')
}

function toPosixPath(filePath) {
  return filePath.split(sep).join('/')
}

function walkDirectory(rootDir) {
  const files = []
  const visit = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      let info
      try {
        info = lstatSync(fullPath)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      const repoPath = toPosixPath(relative(rootDir, fullPath))
      if (!repoPath || repoPath.startsWith('..')) continue
      const buffer = readFileSync(fullPath)
      files.push({ path: repoPath, sha: gitBlobSha(buffer), size: buffer.length, buffer })
    }
  }
  visit(rootDir)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function encodeRefBranch(branch) {
  return String(branch).split('/').map((part) => encodeURIComponent(part)).join('/')
}

function resolveToken(options) {
  return String(options?.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
}

function validateOptions(options) {
  const workDir = options?.workDir
  if (typeof workDir !== 'string' || !workDir.trim()) {
    throw new ContractError(ERROR_CODES.INVALID_INPUT, 'publishRepoPullRequest requires options.workDir', EXIT_CODES.VALIDATION)
  }
  let stats
  try {
    stats = statSync(workDir)
  } catch {
    throw new ContractError(ERROR_CODES.NOT_FOUND, `Work directory not found: ${workDir}`, EXIT_CODES.NOT_FOUND_OR_REFUSED)
  }
  if (!stats.isDirectory()) {
    throw new ContractError(ERROR_CODES.INVALID_INPUT, `options.workDir is not a directory: ${workDir}`, EXIT_CODES.VALIDATION)
  }
  for (const key of ['owner', 'repo', 'title']) {
    if (typeof options[key] !== 'string' || !options[key].trim()) {
      throw new ContractError(ERROR_CODES.INVALID_INPUT, `publishRepoPullRequest requires options.${key}`, EXIT_CODES.VALIDATION)
    }
  }
  if (!/^[A-Za-z0-9._-]+$/.test(options.owner) || !/^[A-Za-z0-9._-]+$/.test(options.repo)) {
    throw new ContractError(ERROR_CODES.INVALID_INPUT, 'owner and repo must be simple GitHub slugs', EXIT_CODES.VALIDATION)
  }
  const body = typeof options.body === 'string' ? options.body : ''
  const missing = REQUIRED_BODY_SECTIONS.filter((section) => !body.includes(section))
  if (missing.length > 0) {
    throw new ContractError(
      ERROR_CODES.REFUSED,
      `PR body is missing required section(s): ${missing.join(', ')}`,
      EXIT_CODES.NOT_FOUND_OR_REFUSED
    )
  }
  return {
    workDir,
    owner: options.owner.trim(),
    repo: options.repo.trim(),
    title: options.title.trim(),
    body,
    branch: String(options.branch || DEFAULT_BRANCH).trim(),
    baseBranch: String(options.baseBranch || DEFAULT_BASE_BRANCH).trim()
  }
}

function resolveBundlePaths(bundleOutPath) {
  const target = String(bundleOutPath)
  if (/\.json$/i.test(target)) return { jsonPath: target, markdownPath: target.replace(/\.json$/i, '.md') }
  if (/\.md$/i.test(target)) return { jsonPath: target.replace(/\.md$/i, '.json'), markdownPath: target }
  return { jsonPath: join(target, 'publication-bundle.json'), markdownPath: join(target, 'publication-bundle.md') }
}

function writePublicationBundle(bundleOutPath, bundle) {
  const { jsonPath, markdownPath } = resolveBundlePaths(bundleOutPath)
  mkdirSync(dirname(jsonPath), { recursive: true })
  mkdirSync(dirname(markdownPath), { recursive: true })
  const files = [...bundle.files].sort((a, b) => a.path.localeCompare(b.path))
  const document = {
    schema_version: 1,
    generated_by: 'hivemind-pr-review',
    owner: bundle.owner,
    repo: bundle.repo,
    branch: bundle.branch,
    base_branch: bundle.baseBranch,
    title: bundle.title,
    body: bundle.body,
    files: files.map((file) => ({
      path: file.path,
      status: file.status,
      sha: file.sha,
      size: file.size
    })),
    pull_request: null
  }
  writeFileSync(jsonPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')

  const markdown = []
  markdown.push('# PR Publication Bundle', '')
  markdown.push(`- Repository: ${bundle.owner}/${bundle.repo}`)
  markdown.push(`- Branch: ${bundle.branch}`)
  markdown.push(`- Base branch: ${bundle.baseBranch}`)
  markdown.push(`- Title: ${bundle.title}`)
  markdown.push('', '## Pull Request Body', '', bundle.body.trim(), '')
  markdown.push('## Files', '', '| Path | Status | Blob SHA |', '| --- | --- | --- |')
  for (const file of files) {
    markdown.push(`| ${file.path.replace(/\|/g, '\\|')} | ${file.status} | ${file.sha} |`)
  }
  writeFileSync(markdownPath, `${markdown.join('\n')}\n`, 'utf8')
  return { jsonPath, markdownPath }
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

export async function publishRepoPullRequest(options = {}) {
  const config = validateOptions(options)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const apiBase = String(options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '')
  const token = resolveToken(options)
  const localFiles = walkDirectory(config.workDir)

  if (!token) {
    if (options.bundleOutPath) {
      writePublicationBundle(options.bundleOutPath, {
        ...config,
        files: localFiles.map((file) => ({
          path: file.path,
          sha: file.sha,
          size: file.size,
          status: 'local'
        }))
      })
    }
    throw new ContractError(
      ERROR_CODES.AUTH_REQUIRED,
      'GitHub token required to publish a pull request (bundle written when bundleOutPath is provided)',
      EXIT_CODES.NOT_FOUND_OR_REFUSED
    )
  }

  if (typeof fetchImpl !== 'function') {
    throw new ContractError(ERROR_CODES.TRANSPORT_ERROR, 'No fetch implementation available to publish pull request', EXIT_CODES.INTERNAL)
  }

  const context = { fetchImpl, apiBase, token, timeoutMs: options.timeoutMs }
  const repoPath = `/repos/${config.owner}/${config.repo}`
  let canPushDirectly
  if (typeof options.direct === 'boolean') {
    canPushDirectly = options.direct
  } else {
    const repoInfo = await githubRequest(context, 'GET', repoPath)
    canPushDirectly = Boolean(repoInfo?.permissions?.push)
  }

  let headOwner = config.owner
  let fork = null
  if (!canPushDirectly) {
    let viewer = typeof options.viewer === 'string' ? options.viewer.trim() : ''
    if (!viewer) {
      const viewerInfo = await githubRequest(context, 'GET', '/user')
      viewer = String(viewerInfo?.login ?? '').trim()
    }
    if (!viewer) {
      throw new ContractError(
        ERROR_CODES.TRANSPORT_ERROR,
        'Unable to determine authenticated GitHub viewer for fork push',
        EXIT_CODES.INTERNAL
      )
    }
    const forkInfo = await githubRequest(context, 'POST', `${repoPath}/forks`, {})
    const forkName = String(forkInfo?.full_name ?? '').trim()
    headOwner = String(
      options.forkOwner ?? forkInfo?.owner?.login ?? (forkName.includes('/') ? forkName.split('/')[0] : viewer)
    ).trim()
    fork = { owner: headOwner, full_name: forkName || `${headOwner}/${config.repo}` }
  }

  const headSpec = `${headOwner}:${config.branch}`
  const existingPulls = await githubRequest(
    context,
    'GET',
    `${repoPath}/pulls?state=open&head=${encodeURIComponent(headSpec)}`
  )
  const openPulls = Array.isArray(existingPulls) ? existingPulls : Array.isArray(existingPulls?.data) ? existingPulls.data : []
  if (openPulls.length > 0) {
    const pull = openPulls[0]
    return {
      created: false,
      pr_url: pull?.html_url ?? null,
      number: pull?.number ?? null,
      branch: config.branch,
      base_branch: config.baseBranch,
      head: headSpec,
      head_sha: pull?.head?.sha ?? null,
      direct: canPushDirectly,
      fork,
      changes: []
    }
  }

  const baseRef = await githubRequest(context, 'GET', `${repoPath}/git/ref/heads/${encodeRefBranch(config.baseBranch)}`)
  const baseCommitSha = String(options.baseCommitSha ?? baseRef?.object?.sha ?? '').trim()
  if (!baseCommitSha) {
    throw new ContractError(ERROR_CODES.TRANSPORT_ERROR, `Unable to resolve base branch "${config.baseBranch}"`, EXIT_CODES.INTERNAL)
  }
  const baseCommit = await githubRequest(context, 'GET', `${repoPath}/git/commits/${baseCommitSha}`)
  const baseTreeSha = String(baseCommit?.tree?.sha ?? '').trim()
  if (!baseTreeSha) {
    throw new ContractError(ERROR_CODES.TRANSPORT_ERROR, 'Unable to resolve base tree sha', EXIT_CODES.INTERNAL)
  }
  const baseTree = await githubRequest(context, 'GET', `${repoPath}/git/trees/${baseTreeSha}?recursive=1`)
  const remoteBlobs = new Map()
  for (const entry of baseTree?.tree ?? []) {
    if (entry?.type === 'blob' && typeof entry.path === 'string') remoteBlobs.set(entry.path, entry)
  }

  const localMap = new Map(localFiles.map((file) => [file.path, file]))
  const overlapCount = [...remoteBlobs.keys()].filter((path) => localMap.has(path)).length
  const deleteAllowSet = Array.isArray(options.deletePaths) ? new Set(options.deletePaths) : null
  if (options.allowPrune && remoteBlobs.size > 0 && overlapCount === 0 && !options.forcePruneAll) {
    throw new ContractError(
      ERROR_CODES.REFUSED,
      'workDir shares zero paths with remote tree; refusing mass deletion without forcePruneAll: true',
      EXIT_CODES.VALIDATION
    )
  }
  const treeEntries = []
  const changes = []
  for (const file of localFiles) {
    const remote = remoteBlobs.get(file.path)
    if (remote && remote.sha === file.sha) continue
    const blob = await githubRequest(context, 'POST', `${repoPath}/git/blobs`, {
      content: file.buffer.toString('base64'),
      encoding: 'base64'
    })
    const fileMode = remote?.mode || ((file.path.endsWith('.sh') || /(?:^|\/)bin\//.test(file.path)) ? '100755' : '100644')
    treeEntries.push({ path: file.path, mode: fileMode, type: 'blob', sha: blob?.sha })
    changes.push({ path: file.path, status: remote ? 'modified' : 'added', sha: blob?.sha })
  }
  if (options.allowPrune === true || deleteAllowSet) {
    for (const [path, remote] of remoteBlobs) {
      if (localMap.has(path)) continue
      if (!options.allowPrune && !deleteAllowSet.has(path)) continue
      treeEntries.push({ path, mode: '100644', type: 'blob', sha: null })
      changes.push({ path, status: 'deleted', sha: remote.sha ?? null })
    }
  }

  const newTree = treeEntries.length > 0
    ? await githubRequest(context, 'POST', `${repoPath}/git/trees`, { base_tree: baseTreeSha, tree: treeEntries })
    : { sha: baseTreeSha }
  const commitMessage = String(options.commitMessage ?? config.title)
  const commit = await githubRequest(context, 'POST', `${repoPath}/git/commits`, {
    message: commitMessage,
    tree: newTree?.sha ?? baseTreeSha,
    parents: [baseCommitSha]
  })
  const commitSha = String(commit?.sha ?? '').trim()
  if (!commitSha) {
    throw new ContractError(ERROR_CODES.TRANSPORT_ERROR, 'GitHub did not return a commit sha', EXIT_CODES.INTERNAL)
  }

  const headRepoPath = `/repos/${headOwner}/${config.repo}`
  const refPath = `${headRepoPath}/git/refs/heads/${encodeRefBranch(config.branch)}`
  try {
    await githubRequest(context, 'PATCH', refPath, { sha: commitSha, force: true })
  } catch (error) {
    if (error?.status === 404 || (error?.status === 422 && /Reference does not exist/i.test(String(error?.message ?? '')))) {
      await githubRequest(context, 'POST', `${headRepoPath}/git/refs`, {
        ref: `refs/heads/${config.branch}`,
        sha: commitSha
      })
    } else {
      throw error
    }
  }

  const pull = await githubRequest(context, 'POST', `${repoPath}/pulls`, {
    title: config.title,
    body: config.body,
    head: headSpec,
    base: config.baseBranch,
    draft: Boolean(options.draft)
  })

  return {
    created: true,
    pr_url: pull?.html_url ?? null,
    number: pull?.number ?? null,
    branch: config.branch,
    base_branch: config.baseBranch,
    head: headSpec,
    head_sha: commitSha,
    direct: canPushDirectly,
    fork,
    changes
  }
}