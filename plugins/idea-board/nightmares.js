import { randomUUID } from 'node:crypto'
import { openStorageUnit } from './dreams.js'

/** Lifecycle states a nightmare can hold. */
export const NIGHTMARE_STATUSES = ['open', 'accepted', 'fixed', 'ignored', 'removed']

/** Decisions the approver can apply to one nightmare. */
export const NIGHTMARE_ACTIONS = ['accept', 'fix', 'ignore', 'remove', 'reopen']

/** Status each decision moves a nightmare into. */
const ACTION_STATUS = {
  accept: 'accepted',
  fix: 'fixed',
  ignore: 'ignored',
  remove: 'removed',
  reopen: 'open',
}

/** Decisions that require the approver to say why. */
const COMMENT_REQUIRED = new Set(['ignore', 'remove'])

/** Statuses that still demand an approval decision. */
const PENDING = new Set(['open', 'accepted'])

/** Severity order used when sorting; unknown severities sort last. */
const SEVERITY_RANK = { error: 0, warn: 1, info: 2 }

const UNIT = 'nightmare_board'
const TABLE = 'nightmares'
const MAX_NIGHTMARES = 400
const MAX_HISTORY = 20
const MAX_SUMMARY = 600
const MAX_COMMENT = 1000

/** A request the caller must fix before retrying. */
export class NightmareError extends Error {
  /**
   * @param message - human-readable reason.
   * @param code - stable machine code.
   */
  constructor(message, code = 'invalid') {
    super(message)
    this.code = code
  }
}

/**
 * Read one bounded, trimmed string.
 * @param value - candidate value.
 * @param max - maximum accepted length.
 * @returns the trimmed string, or ''.
 */
function text(value, max = MAX_COMMENT) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/**
 * Normalize one evidence entry from a doctor finding.
 * @param value - candidate evidence item.
 * @returns the accepted evidence, or null.
 */
function evidenceEntry(value) {
  if (value === null || typeof value !== 'object') return null
  const path = text(value.path, 500)
  if (path === '') return null
  return { path, detail: text(value.detail, MAX_SUMMARY) }
}

/**
 * Normalize the typed fix a doctor finding carries.
 * @param value - candidate fix.
 * @returns the accepted fix, or null.
 */
function fixValue(value) {
  if (value === null || typeof value !== 'object') return null
  const type = text(value.type, 20)
  if (!['command', 'mutation', 'manual'].includes(type)) return null
  const steps = Array.isArray(value.steps)
    ? value.steps.map((step) => text(step, 400)).filter((step) => step !== '').slice(0, 8)
    : []
  return { type, summary: text(value.summary, MAX_SUMMARY), steps }
}

/**
 * Build the stable identity of one finding so a rescan updates instead of duplicating.
 *
 * The check id pins the invariant; the evidence paths pin the specific subject.
 * A finding that fixes one of several subjects therefore becomes a new entry and
 * the old one closes when its check reports no failure.
 * @param checkId - doctor check id.
 * @param evidence - normalized evidence list.
 * @returns the fingerprint string.
 */
export function fingerprintOf(checkId, evidence) {
  const paths = evidence.map((item) => item.path).sort()
  return `${checkId}|${paths.join(',')}`
}

/**
 * Normalize one doctor finding into the fields a nightmare stores.
 * @param input - candidate finding.
 * @param now - current epoch milliseconds.
 * @returns the normalized subject.
 */
export function normalizeFinding(input, now = Date.now()) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  const checkId = text(raw.checkId ?? raw.id, 120)
  if (checkId === '') throw new NightmareError('a finding needs a check id', 'invalid')
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.map(evidenceEntry).filter((entry) => entry !== null).slice(0, 12)
    : []
  const severity = ['error', 'warn', 'info'].includes(raw.severity) ? raw.severity : 'warn'
  return {
    checkId,
    severity,
    group: text(raw.group, 40),
    title: text(raw.title ?? checkId, 200),
    summary: text(raw.summary, MAX_SUMMARY),
    evidence,
    fix: fixValue(raw.fix),
    fingerprint: fingerprintOf(checkId, evidence),
    lastSeen: now,
  }
}

/**
 * Build the one-shot instruction a squash session receives.
 *
 * The text names the finding, its evidence, the suggested repair, and the check
 * that must pass afterwards. It also forbids weakening the check, so a session
 * cannot make the backlog green by editing the checker.
 *
 * @param nightmare - stored nightmare.
 * @param options - `{ cwd }` project directory the session works in.
 * @returns the prompt text.
 */
export function buildSquashPrompt(nightmare, options = {}) {
  const cwd = text(options.cwd, 400) || '.'
  const lines = [
    'Fix one dsh-doctor finding in this workspace, then prove it is gone.',
    '',
    `Workspace: ${cwd}`,
    '',
    'Finding',
    `- check: ${nightmare.checkId}`,
  ]
  const meta = [nightmare.group, nightmare.severity].filter((part) => typeof part === 'string' && part !== '')
  if (meta.length > 0) lines.push(`- classification: ${meta.join(', ')}`)
  if (typeof nightmare.title === 'string' && nightmare.title !== '') lines.push(`- title: ${nightmare.title}`)
  lines.push(`- summary: ${nightmare.summary}`)
  const evidence = Array.isArray(nightmare.evidence) ? nightmare.evidence : []
  if (evidence.length > 0) {
    lines.push('', 'Evidence')
    for (const item of evidence) {
      lines.push(`- ${item.path}${typeof item.detail === 'string' && item.detail !== '' ? ` — ${item.detail}` : ''}`)
    }
  }
  if (nightmare.fix !== null && nightmare.fix !== undefined) {
    lines.push('', `Suggested repair (${nightmare.fix.type})`)
    if (typeof nightmare.fix.summary === 'string' && nightmare.fix.summary !== '') lines.push(`- ${nightmare.fix.summary}`)
    for (const step of Array.isArray(nightmare.fix.steps) ? nightmare.fix.steps : []) lines.push(`- ${step}`)
  }
  lines.push(
    '',
    'Acceptance',
    `- \`node dsh-doctor/bin/dsh-doctor.mjs --check ${nightmare.checkId}\` reports PASS for this check.`,
    '- Run the project\'s own tests for every file you touch.',
    '- Do not weaken, skip, rename, or delete the check to make it pass. If the finding is wrong, say so and explain why instead of editing the checker.',
    '',
    'Report what changed and paste the command output that proves the check now passes.',
  )
  return lines.join('\n')
}

/**
 * Sort nightmares for review: undecided first, then by severity and recency.
 * @param left - nightmare.
 * @param right - nightmare.
 * @returns comparison result.
 */
function byReviewOrder(left, right) {
  const rank = (entry) => (PENDING.has(entry.status) ? 0 : 1)
  const statusOrder = { open: 0, accepted: 1, fixed: 2, ignored: 3, removed: 4 }
  if (rank(left) !== rank(right)) return rank(left) - rank(right)
  if (left.status !== right.status) return (statusOrder[left.status] ?? 9) - (statusOrder[right.status] ?? 9)
  const severity = (SEVERITY_RANK[left.severity] ?? 9) - (SEVERITY_RANK[right.severity] ?? 9)
  if (severity !== 0) return severity
  return (right.lastSeen ?? 0) - (left.lastSeen ?? 0)
}

/**
 * Create the nightmare board: a durable backlog of dsh-doctor findings that wait
 * for an explicit approve, fix, ignore, or remove decision.
 *
 * @param ctx - the Cordis context.
 * @param config - plugin configuration.
 * @returns the board API.
 */
export function createNightmareBoard(ctx, config = {}) {
  const cache = { unit: null, nightmares: new Map(), meta: null }
  let opening = null
  let queue = Promise.resolve()

  /** Serialize store mutations so a decision cannot interleave with an ingest. */
  const serialize = (task) => {
    const run = queue.then(task, task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  const emptyMeta = () => ({ version: 1, revision: 0, lastIngestAt: null, lastSource: null })

  /** Open the storage unit once and cache its records. */
  const open = async () => {
    if (cache.meta !== null) return cache
    if (opening !== null) return opening
    opening = (async () => {
      const hub = ctx.get('storage')
      if (hub === undefined) throw new NightmareError('the storage service is unavailable in this profile', 'storage-unavailable')
      const names = hub.backend.names()
      const backendName = names.includes('json') ? 'json' : names[0]
      if (backendName === undefined) throw new NightmareError('no storage backend is mounted', 'storage-unavailable')
      const backend = hub.backend.get(backendName)
      if (backend.kv === undefined) throw new NightmareError(`storage backend "${backendName}" has no key-value facet`, 'storage-unavailable')
      const unit = await openStorageUnit(backend, UNIT, [TABLE, 'meta'])
      cache.unit = unit
      const loaded = await unit.loadAll()
      for (const [id, value] of Object.entries(loaded.tables[TABLE] ?? {})) {
        if (value !== null && typeof value === 'object' && typeof value.id === 'string') cache.nightmares.set(id, value)
      }
      cache.meta = loaded.tables.meta?.current !== undefined
        ? { ...emptyMeta(), ...loaded.tables.meta.current }
        : emptyMeta()
      opening = null
      return cache
    })()
    opening.catch(() => { opening = null })
    return opening
  }

  /** Persist the metadata record. */
  const persistMeta = async () => {
    await cache.unit.putRecord('meta', 'current', cache.meta)
  }

  /** Persist one nightmare and bump the revision. */
  const put = async (nightmare) => {
    await cache.unit.putRecord(TABLE, nightmare.id, nightmare)
    cache.nightmares.set(nightmare.id, nightmare)
    cache.meta.revision += 1
  }

  /** Append one transition to a nightmare's history, bounded. */
  const recordTransition = (nightmare, from, to, comment, at) => {
    nightmare.history = [
      ...(Array.isArray(nightmare.history) ? nightmare.history : []),
      { at, from, to, comment },
    ].slice(-MAX_HISTORY)
  }

  /** Drop the oldest decided entries once the board exceeds its cap. */
  const enforceCap = async () => {
    if (cache.nightmares.size <= MAX_NIGHTMARES) return
    const terminal = [...cache.nightmares.values()]
      .filter((entry) => !PENDING.has(entry.status))
      .sort((left, right) => (left.lastSeen ?? 0) - (right.lastSeen ?? 0))
    let overflow = cache.nightmares.size - MAX_NIGHTMARES
    for (const entry of terminal) {
      if (overflow <= 0) break
      await cache.unit.deleteRecord(TABLE, entry.id)
      cache.nightmares.delete(entry.id)
      overflow -= 1
    }
  }

  /**
   * Add or refresh the nightmares described by one doctor run.
   *
   * Passing findings close the nightmares for that check, so a fixed problem
   * leaves the board without the approver having to clear it by hand. The
   * `passing` list carries check ids that passed even when the caller only
   * submits the defects, which is what a compact feed does.
   *
   * @param input - `{ findings, passing, source }` from a doctor report.
   * @param sessionId - session that submitted the run, when known.
   * @returns counts of what changed.
   */
  const ingest = (input, sessionId) => serialize(async () => {
    await open()
    const raw = input !== null && typeof input === 'object' ? input : {}
    const findings = Array.isArray(raw.findings) ? raw.findings : []
    const listedPassing = Array.isArray(raw.passing)
      ? raw.passing.map((id) => text(id, 120)).filter((id) => id !== '')
      : []
    if (findings.length === 0 && listedPassing.length === 0) {
      throw new NightmareError('ingest needs at least one finding or one passing check id', 'invalid')
    }
    const now = Date.now()
    const source = text(raw.source, 80) || 'dsh-doctor'
    const failing = []
    const passingChecks = new Set(listedPassing)
    for (const finding of findings) {
      const status = text(finding?.status, 20)
      if (status === 'pass') {
        const id = text(finding?.id ?? finding?.checkId, 120)
        if (id !== '') passingChecks.add(id)
        continue
      }
      if (status === 'skip') continue
      failing.push(normalizeFinding(finding, now))
    }
    const seen = new Set()
    let added = 0
    let updated = 0
    let reopened = 0
    for (const subject of failing) {
      seen.add(subject.fingerprint)
      const existing = [...cache.nightmares.values()].find((entry) => entry.fingerprint === subject.fingerprint)
      if (existing === undefined) {
        const nightmare = {
          id: `nrm_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          ...subject,
          status: 'open',
          occurrences: 1,
          firstSeen: now,
          decision: null,
          resolvedAt: null,
          source,
          history: [{ at: now, from: null, to: 'open', comment: `found by ${source}` }],
        }
        await put(nightmare)
        added += 1
        continue
      }
      existing.lastSeen = now
      existing.occurrences = (existing.occurrences ?? 1) + 1
      existing.summary = subject.summary
      existing.severity = subject.severity
      existing.evidence = subject.evidence
      existing.fix = subject.fix
      if (existing.status === 'fixed') {
        existing.status = 'open'
        existing.decision = null
        existing.resolvedAt = null
        recordTransition(existing, 'fixed', 'open', 'the finding came back', now)
        reopened += 1
      }
      await put(existing)
      updated += 1
    }
    let cleared = 0
    for (const entry of [...cache.nightmares.values()]) {
      if (!PENDING.has(entry.status)) continue
      if (seen.has(entry.fingerprint)) continue
      if (!passingChecks.has(entry.checkId)) continue
      const from = entry.status
      entry.status = 'fixed'
      entry.resolvedAt = now
      entry.decision = { action: 'fix', comment: `auto: ${entry.checkId} now passes`, at: now, by: source }
      recordTransition(entry, from, 'fixed', 'auto: the check now passes', now)
      await put(entry)
      cleared += 1
    }
    cache.meta.lastIngestAt = now
    cache.meta.lastSource = source
    cache.meta.revision += 1
    await persistMeta()
    await enforceCap()
    return { added, updated, reopened, cleared, submitted: findings.length, sessionId: sessionId ?? null }
  })

  /**
   * Apply one approval decision to a nightmare.
   *
   * @param input - `{ id, action, comment }`.
   * @param by - approver identity for the audit trail.
   * @returns the updated nightmare.
   */
  const decide = (input, by) => serialize(async () => {
    await open()
    const raw = input !== null && typeof input === 'object' ? input : {}
    const id = text(raw.id, 80)
    const nightmare = cache.nightmares.get(id)
    if (nightmare === undefined) throw new NightmareError(`unknown nightmare: ${id}`, 'not-found')
    const action = text(raw.action, 20)
    if (!NIGHTMARE_ACTIONS.includes(action)) {
      throw new NightmareError(`unknown action: ${action}; expected one of ${NIGHTMARE_ACTIONS.join(', ')}`, 'invalid')
    }
    const comment = text(raw.comment)
    if (COMMENT_REQUIRED.has(action) && comment === '') {
      throw new NightmareError(`"${action}" needs a comment saying why`, 'invalid')
    }
    const next = ACTION_STATUS[action]
    if (nightmare.status === next) throw new NightmareError(`nightmare ${id} is already ${next}`, 'invalid')
    const now = Date.now()
    const from = nightmare.status
    nightmare.status = next
    nightmare.decision = { action, comment, at: now, by: text(by, 120) || 'operator' }
    nightmare.resolvedAt = next === 'fixed' || next === 'removed' ? now : null
    recordTransition(nightmare, from, next, comment, now)
    await put(nightmare)
    await persistMeta()
    return nightmare
  })

  /**
   * Record that a repair session started for one nightmare.
   *
   * The entry moves to `accepted` and keeps the session id, so the board shows
   * work in flight. The next doctor run that passes the check closes it, which
   * is the only thing that can honestly call a nightmare fixed.
   *
   * @param id - nightmare id.
   * @param sessionId - launched session identity, when known.
   * @returns the updated nightmare.
   */
  const beginSquash = (id, sessionId) => serialize(async () => {
    await open()
    const nightmare = cache.nightmares.get(text(id, 80))
    if (nightmare === undefined) throw new NightmareError(`unknown nightmare: ${id}`, 'not-found')
    const now = Date.now()
    const from = nightmare.status
    const session = text(sessionId, 120)
    const comment = session === '' ? 'squash session started' : `squash session started (${session})`
    nightmare.status = 'accepted'
    nightmare.resolvedAt = null
    nightmare.decision = { action: 'accept', comment, at: now, by: 'operator' }
    nightmare.squashSessionId = session === '' ? null : session
    nightmare.squashedAt = now
    if (from !== 'accepted') recordTransition(nightmare, from, 'accepted', comment, now)
    await put(nightmare)
    await persistMeta()
    return nightmare
  })

  /** List the board in review order. */  const list = async () => {
    await open()
    return [...cache.nightmares.values()].sort(byReviewOrder)
  }

  /** Read one nightmare. */
  const get = async (id) => {
    await open()
    return cache.nightmares.get(text(id, 80)) ?? null
  }

  /** Build the board state the panel renders. */
  const state = async () => {
    const nightmares = await list()
    const counts = { open: 0, accepted: 0, fixed: 0, ignored: 0, removed: 0, total: nightmares.length }
    for (const entry of nightmares) {
      if (counts[entry.status] !== undefined) counts[entry.status] += 1
    }
    return {
      nightmares,
      counts,
      actions: NIGHTMARE_ACTIONS,
      lastIngestAt: cache.meta?.lastIngestAt ?? null,
      lastSource: cache.meta?.lastSource ?? null,
      caps: { maxNightmares: MAX_NIGHTMARES },
    }
  }

  return { open, ingest, decide, beginSquash, list, get, state }
}
