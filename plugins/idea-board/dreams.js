/**
 * Dream Board domain: the durable store for AI-generated dreams, the discard
 * ledger, the run log, dedup, readiness, and the fleet execution spec.
 *
 * One owner (this plugin) opens the storage units, so the tools, the command,
 * and the HTTP routes all read and write the same cached state. Nothing here
 * touches the idea board, session logs, or project code.
 */

import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { buildFleetPrompt, writeBrief } from './brief.js'
import { activityDigest } from './activity.js'

/** Model-facing scoring rubric, also shown in the Dream Board. */
export const RUBRIC = [
  { key: 'value', label: 'Value to user', hint: 'Does it remove painful, recurring work?' },
  { key: 'niche', label: 'Niche specificity', hint: 'Named user, narrow workflow, not "everyone".' },
  { key: 'revenue', label: 'Revenue potential', hint: 'Who pays, how, and rough market size.' },
  { key: 'feasibility', label: 'Feasibility', hint: 'Buildable by a solo dev or small team.' },
  { key: 'fit', label: 'Fit with existing work', hint: 'Builds on current projects and context.' },
]

/** Accepted dream statuses. */
export const DREAM_STATUSES = ['incubating', 'ready_for_review', 'pursued', 'discarded']

/** Outcomes the discard ledger records. */
export const DISCARD_OUTCOMES = ['discarded', 'retired', 'pursued']

const MAX_DREAMS_PER_SAVE = 500
const MAX_DISCARDS = 500
const MAX_RUNS = 40
const LOCK_TTL_MS = 2 * 60 * 60 * 1000
const SIMILARITY_THRESHOLD = 0.6
const SIMILARITY_MIN_SHARED = 3
const MAX_FIELD = 4000

/** Harness-generated user messages that carry no product friction. */
const NOISE_PREFIX = [
  'Time sampled while preparing',
  'Current runtime context.',
  'The user changed the approval policy',
  'Background subagent',
  'background job ',
  'Agent ',
  '<system-reminder>',
  '<goal_complete>',
]

/** Words that carry no concept signal for dedup. */
const STOP_WORDS = new Set((
  'a an the and or for to of in on with that this it is are be as at by from your you my our we their they '
  + 'app apps application feature features tool tools idea ideas dream dreams build make new using use used '
  + 'help helps helping platform service services product products system systems need needs'
).split(' '))

/** A request the caller must fix before retrying. */
export class DreamError extends Error {
  /** @param message - human-readable reason. @param code - stable machine code. */
  constructor(message, code = 'invalid') {
    super(message)
    this.code = code
  }
}

/**
 * Open one single-layout storage unit, recovering a handle left open by a
 * previous instance of this plugin (the JSON backend keeps one handle per unit
 * and a plugin reload can race its own teardown).
 * @param backend - the storage backend.
 * @param name - unit name.
 * @param tables - table names.
 * @returns the opened unit.
 */
export async function openStorageUnit(backend, name, tables) {
  const descriptor = { name, version: 1, tables, hasGlobal: false, layout: 'single' }
  try {
    return await backend.kv.open(descriptor)
  } catch (error) {
    const stale = backend.open instanceof Map ? backend.open.get(name) : undefined
    if (stale === undefined || typeof stale.close !== 'function') throw error
    console.warn(`idea-board: closing a stale storage handle for "${name}"`)
    await stale.close()
    return backend.kv.open(descriptor)
  }
}

/**
 * Read one bounded, trimmed string.
 * @param value - candidate value.
 * @param max - maximum accepted length.
 * @returns the trimmed string, or ''.
 */
function text(value, max = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/**
 * Read one bounded string list.
 * @param value - candidate array.
 * @param maxItems - maximum accepted entries.
 * @param maxLength - maximum length of one entry.
 * @returns the accepted strings.
 */
function stringList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    const next = text(entry, maxLength)
    if (next !== '') out.push(next)
    if (out.length >= maxItems) break
  }
  return out
}

/**
 * Read one score in the 1..5 rubric range.
 * @param value - candidate score.
 * @returns the integer score, or 1 when absent.
 */
function score(value) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 1
  return Math.min(5, Math.max(1, number))
}

/**
 * Normalize the competitive analysis fields.
 * @param value - candidate `competitive` object.
 * @returns the accepted analysis.
 */
function competitive(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  const competitors = []
  if (Array.isArray(source.competitors)) {
    for (const raw of source.competitors) {
      if (raw === null || typeof raw !== 'object') continue
      const name = text(raw.name, 120)
      if (name === '') continue
      competitors.push({
        name,
        url: text(raw.url, 500),
        pricing: text(raw.pricing, 300),
        gap: text(raw.gap, 600),
      })
      if (competitors.length >= 8) break
    }
  }
  return { summary: text(source.summary, MAX_FIELD), competitors }
}

/**
 * Normalize the source attribution block.
 * @param value - candidate `sources` object.
 * @returns the accepted sources.
 */
function sources(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  const web = []
  if (Array.isArray(source.web)) {
    for (const raw of source.web) {
      if (raw === null || typeof raw !== 'object') continue
      const url = text(raw.url, 800)
      if (url === '') continue
      web.push({ url, title: text(raw.title, 200) })
      if (web.length >= 12) break
    }
  }
  const ideas = []
  if (Array.isArray(source.ideas)) {
    for (const raw of source.ideas) {
      if (raw === null || typeof raw !== 'object') continue
      const title = text(raw.title, 200)
      if (title === '') continue
      ideas.push({ id: text(raw.id, 80), title })
      if (ideas.length >= 12) break
    }
  }
  const sessions = []
  if (Array.isArray(source.sessions)) {
    for (const raw of source.sessions) {
      if (raw === null || typeof raw !== 'object') continue
      const title = text(raw.title, 200)
      if (title === '') continue
      sessions.push({ id: text(raw.id, 80), title })
      if (sessions.length >= 12) break
    }
  }
  return { web, ideas, sessions }
}

/**
 * Normalize one revision-log entry.
 * @param value - candidate entry.
 * @returns the accepted entry, or null.
 */
function revisionEntry(value) {
  if (value === null || typeof value !== 'object') return null
  const change = text(value.change, 600)
  if (change === '') return null
  return { at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : Date.now(), change }
}

/**
 * Normalize a dream submitted by the dreamer or an existing stored dream.
 * @param input - candidate dream object.
 * @param previous - stored dream when this is an update.
 * @param now - current epoch milliseconds.
 * @returns the accepted dream.
 */
export function normalizeDream(input, previous, now) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  const prior = previous !== null && previous !== undefined && typeof previous === 'object' ? previous : {}
  const pick = (key, max) => {
    const next = text(raw[key], max)
    return next !== '' ? next : text(prior[key], max)
  }
  const type = raw.type === 'application'
    ? 'application'
    : raw.type === 'service' ? 'service' : raw.type === 'feature' ? 'feature' : prior.type === 'application' ? 'application' : prior.type === 'service' ? 'service' : 'feature'
  const scores = {}
  const sourceScores = raw.scores !== null && typeof raw.scores === 'object'
    ? raw.scores
    : prior.scores !== null && typeof prior.scores === 'object' ? prior.scores : {}
  let total = 0
  for (const entry of RUBRIC) {
    scores[entry.key] = score(sourceScores[entry.key])
    total += scores[entry.key]
  }
  const revisionLog = []
  if (Array.isArray(prior.revisionLog)) revisionLog.push(...prior.revisionLog.slice(-40))
  if (Array.isArray(raw.revisionLog)) {
    for (const entry of raw.revisionLog) {
      const parsed = revisionEntry(entry)
      if (parsed !== null) revisionLog.push(parsed)
    }
  }
  const merged = {
    id: previous !== undefined ? previous.id : `drm_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    title: pick('title', 200),
    pitch: pick('pitch', 400),
    type,
    problem: pick('problem', MAX_FIELD),
    targetUser: pick('targetUser', 1000),
    value: pick('value', MAX_FIELD),
    monetization: pick('monetization', 1000),
    competitive: raw.competitive !== undefined
      ? competitive(raw.competitive)
      : prior.competitive !== null && typeof prior.competitive === 'object' ? prior.competitive : competitive(undefined),
    architecture: pick('architecture', 6000),
    mvpScope: Array.isArray(raw.mvpScope) ? stringList(raw.mvpScope, 12, 300) : Array.isArray(prior.mvpScope) ? prior.mvpScope : [],
    effort: pick('effort', 300),
    sources: raw.sources !== undefined
      ? sources(raw.sources)
      : prior.sources !== null && typeof prior.sources === 'object' ? prior.sources : sources(undefined),
    scores,
    totalScore: total,
    iterationCount: previous !== undefined ? previous.iterationCount : 0,
    status: raw.status === 'ready_for_review' ? 'ready_for_review' : prior.status === 'ready_for_review' ? 'ready_for_review' : 'incubating',
    createdAt: previous !== undefined ? previous.createdAt : now,
    lastRefinedAt: now,
    revisionLog: revisionLog.slice(-40),
    tags: Array.isArray(raw.tags) ? stringList(raw.tags, 8, 40) : Array.isArray(prior.tags) ? prior.tags : [],
    distinction: pick('distinction', 600),
  }
  return merged
}

/**
 * Decide whether a dream meets the review bar.
 * @param dream - normalized dream.
 * @returns true when problem, user, competitors, MVP, architecture, and monetization are present.
 */
export function isReady(dream) {
  if (dream.problem === '' || dream.targetUser === '' || dream.architecture === '') return false
  if (dream.competitive.competitors.length === 0) return false
  if (dream.mvpScope.length === 0) return false
  if ((dream.type === 'application' || dream.type === 'service') && (dream.monetization === '' || dream.monetization.toLowerCase() === 'n/a')) return false
  return true
}

/**
 * Build the concept tokens used for dedup.
 * @param textValue - free text describing the concept.
 * @returns unique significant tokens.
 */
function conceptTokens(textValue) {
  const tokens = String(textValue)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
  return [...new Set(tokens)].slice(0, 80)
}

/**
 * Describe one dream as a dedup token list.
 * @param dream - normalized dream.
 * @returns concept tokens.
 */
export function dreamTokens(dream) {
  return conceptTokens([
    dream.title, dream.pitch, dream.problem, dream.targetUser, dream.architecture, dream.mvpScope.join(' '),
  ].join(' '))
}

/**
 * Compare two concept token lists.
 * @param a - token list.
 * @param b - token list.
 * @returns `{ score, shared }` where score is shared/min(size).
 */
export function tokenSimilarity(a, b) {
  const setA = new Set(a)
  const setB = new Set(b)
  let shared = 0
  for (const token of setA) if (setB.has(token)) shared += 1
  const denominator = Math.max(1, Math.min(setA.size, setB.size))
  return { score: shared / denominator, shared }
}

/**
 * Normalize a title for identity comparison.
 * @param value - candidate title.
 * @returns lowercase alphanumeric words separated by single spaces.
 */
export function normalizeTitle(value) {
  return typeof value === 'string'
    ? value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    : ''
}

/**
 * Overlap coefficient of two token lists, sensitive to verbatim copies.
 * @param a - token list.
 * @param b - token list.
 * @returns `{ score, shared }` where score is shared/min(size).
 */
export function tokenOverlap(a, b) {
  const setA = new Set(a)
  const setB = new Set(b)
  let shared = 0
  for (const token of setA) if (setB.has(token)) shared += 1
  return { score: shared / Math.max(1, Math.min(setA.size, setB.size)), shared }
}

/**
 * The rubric fields a dream is still missing, in fill order.
 * @param dream - normalized dream.
 * @returns field names.
 */
export function missingSections(dream) {
  const missing = []
  if (text(dream.problem, 1) === '') missing.push('problem')
  if (text(dream.targetUser, 1) === '') missing.push('targetUser')
  if (text(dream.value, 1) === '') missing.push('value')
  if (text(dream.architecture, 1) === '') missing.push('architecture')
  if (!Array.isArray(dream.mvpScope) || dream.mvpScope.length === 0) missing.push('mvpScope')
  if (!Array.isArray(dream.competitive?.competitors) || dream.competitive.competitors.length === 0) missing.push('competitive')
  if ((dream.type === 'application' || dream.type === 'service') && text(dream.monetization, 1) === '') missing.push('monetization')
  if (text(dream.effort, 1) === '') missing.push('effort')
  return missing
}

/**
 * Whether a dream carries no substance beyond its title and pitch.
 * @param dream - normalized dream.
 * @returns true for a bare stub.
 */
export function isDreamStub(dream) {
  return text(dream?.problem, 1) === '' && text(dream?.targetUser, 1) === '' && text(dream?.value, 1) === ''
}

/**
 * One-line summary of an active dream for the Dreamer context.
 * @param dream - full dream.
 * @returns the compact row.
 */
function compactDream(dream) {
  const missing = missingSections(dream)
  return {
    id: dream.id,
    title: dream.title,
    status: dream.status,
    totalScore: dream.totalScore,
    pitch: text(dream.pitch, 180),
    tags: dream.tags,
    missing,
    weakest: missing[0] ?? null,
    lastRefinedAt: dream.lastRefinedAt,
  }
}

/**
 * One-line summary of a ledger entry for the Dreamer context.
 * @param entry - discard or pursued entry.
 * @returns the compact row.
 */
function compactLedgerEntry(entry) {
  return {
    title: entry.title,
    summary: text(entry.summary, 180),
    outcome: entry.outcome,
    tags: entry.tags,
    date: entry.date,
    reason: text(entry.reason, 160),
  }
}

/**
 * One-line summary of a pursued entry, with its packet and session.
 * @param entry - pursued ledger entry.
 * @returns the compact row.
 */
function compactPursued(entry) {
  const reason = typeof entry.reason === 'string' ? entry.reason : ''
  const packet = /packet ([^\s—]+)/.exec(reason)?.[1] ?? null
  const session = /\(session-[^)]+\)/.exec(reason)?.[0]?.slice(1, -1) ?? null
  return {
    title: entry.title,
    summary: text(entry.summary, 200),
    tags: entry.tags,
    date: entry.date,
    packet,
    session,
  }
}


/** Stable dream ordering: ready first, then total score, then recency. */
function byReviewPriority(a, b) {
  const rank = (dream) => (dream.status === 'ready_for_review' ? 1 : 0)
  return rank(b) - rank(a) || b.totalScore - a.totalScore || b.lastRefinedAt - a.lastRefinedAt
}

/**
 * Create the Dream Board store over the composition's storage service.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 * @param readIdeas - async reader returning the current idea board items.
 * @returns the store API used by tools, command, routes, and schedule wiring.
 */
/**
 * Launch a one-shot Fleet session seeded with one instruction.
 *
 * The schedule service owns session creation: one task is created, run
 * immediately, then deleted so a failed launch can never fire later.
 *
 * @param ctx - the Cordis context.
 * @param options - `{ title, prompt, cwd }`.
 * @returns the launched session and the transient task id.
 */
export async function launchFleetSession(ctx, options = {}) {
  const schedule = ctx.get('schedule')
  if (schedule === undefined) throw new DreamError('the schedule service is unavailable', 'schedule-unavailable')
  const task = await schedule.create({
    title: String(options.title ?? 'Fleet task').slice(0, 120),
    prompt: String(options.prompt ?? ''),
    timing: { kind: 'after', after_seconds: 60 },
    target: { kind: 'new_once', create: { cwd: options.cwd, agentPreset: 'fleet' } },
  })
  let result
  try {
    result = await schedule.run({ id: task.id })
  } finally {
    // The one-shot task must never fire later when this launch failed.
    try { await schedule.edit({ id: task.id, action: 'delete' }) } catch (error) { console.warn('idea-board: could not delete launch task', error) }
  }
  if (result !== null && typeof result === 'object' && result.code === 'schedule_execution_pending') {
    throw new DreamError('a delivery is already pending', 'busy')
  }
  const sessionId = result?.lastDelivery?.targetSessionId
  return { sessionId: typeof sessionId === 'string' ? sessionId : null, taskId: task.id }
}

/**
 * Create the Dream Board: the active dream set, the discard/pursued ledger, the
 * run log, and the fleet execution spec.
 *
 * @param ctx - the Cordis context.
 * @param config - plugin configuration.
 * @param readIdeas - reads the idea board for ingest.
 * @returns the board API.
 */
export function createDreamBoard(ctx, config, readIdeas) {
  const cache = {
    unit: null, metaUnit: null, discardsUnit: null, runsUnit: null, dreams: new Map(),
    discards: [], runs: [], meta: null, runAdditions: new Map(), runSaves: new Map(), cleaned: false,
  }
  let opening = null
  let queue = Promise.resolve()

  /** Serialize store mutations so revisions and the lock cannot interleave. */
  const serialize = (task) => {
    const run = queue.then(task, task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Default metadata for a fresh board. */
  const emptyMeta = () => ({
    version: 1,
    revision: 0,
    scheduleId: null,
    scheduleSignature: null,
    lock: null,
  })

  /** Open the three units once and cache their records. */
  const open = async () => {
    if (cache.meta !== null) return cache
    if (opening !== null) return opening
    opening = (async () => {
      const hub = ctx.get('storage')
      if (hub === undefined) throw new DreamError('the storage service is unavailable in this profile', 'storage-unavailable')
      const names = hub.backend.names()
      const backendName = names.includes('json') ? 'json' : names[0]
      if (backendName === undefined) throw new DreamError('no storage backend is mounted', 'storage-unavailable')
      const backend = hub.backend.get(backendName)
      if (backend.kv === undefined) throw new DreamError(`storage backend "${backendName}" has no key-value facet`, 'storage-unavailable')
      const openUnit = (name, tables) => openStorageUnit(backend, name, tables)
      const board = await openUnit('dream_board', ['dreams', 'meta'])
      const discards = await openUnit('dream_discards', ['entries'])
      const runs = await openUnit('dream_runs', ['runs'])
      cache.unit = board
      cache.discardsUnit = discards
      cache.runsUnit = runs
      const loadedBoard = await board.loadAll()
      const loadedDiscards = await discards.loadAll()
      const loadedRuns = await runs.loadAll()
      for (const [id, value] of Object.entries(loadedBoard.tables.dreams ?? {})) {
        if (value !== null && typeof value === 'object' && typeof value.id === 'string') cache.dreams.set(id, value)
      }
      cache.meta = loadedBoard.tables.meta?.current !== undefined
        ? { ...emptyMeta(), ...loadedBoard.tables.meta.current }
        : emptyMeta()
      cache.discards = Object.values(loadedDiscards.tables.entries ?? {})
      cache.runs = Object.values(loadedRuns.tables.runs ?? {}).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, MAX_RUNS)
      if (!cache.cleaned) {
        await cleanupPursuedStubs()
        cache.cleaned = true
      }
      opening = null
      return cache
    })()
    opening.catch(() => { opening = null })
    return opening
  }

  /** Persist the current metadata record. */
  const persistMeta = async () => {
    await cache.unit.putRecord('meta', 'current', cache.meta)
  }

  /** Persist one dream record. */
  const putDream = async (dream) => {
    await cache.unit.putRecord('dreams', dream.id, dream)
    cache.dreams.set(dream.id, dream)
    cache.meta.revision += 1
  }

  /** Persist one discard record. */
  const putDiscard = async (entry) => {
    await cache.discardsUnit.putRecord('entries', entry.id, entry)
    cache.discards.push(entry)
    if (cache.discards.length > MAX_DISCARDS) {
      const removed = cache.discards.splice(0, cache.discards.length - MAX_DISCARDS)
      await cache.discardsUnit.deleteRecords('entries', removed.map((row) => row.id))
    }
  }

  /** Persist the newest run record. */
  const putRun = async (run) => {
    await cache.runsUnit.putRecord('runs', run.id, run)
    cache.runs.unshift(run)
    if (cache.runs.length > MAX_RUNS) {
      const removed = cache.runs.splice(MAX_RUNS)
      await cache.runsUnit.deleteRecords('runs', removed.map((row) => row.id))
    }
  }

  /** Build the dedup entry for one dream. */
  const discardEntry = (dream, reason, outcome) => ({
    id: `dsc_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    dreamId: dream.id,
    title: dream.title,
    summary: dream.pitch,
    mechanics: { problem: dream.problem, targetUser: dream.targetUser, approach: dream.architecture },
    tags: dream.tags,
    reason: text(reason, 600),
    outcome,
    date: new Date().toISOString(),
    tokens: dreamTokens(dream),
  })

  /**
   * Move one dream out of the active board into the discard ledger.
   * @param id - dream identity.
   * @param reason - one-line reason.
   * @param outcome - ledger outcome.
   * @returns the ledger entry.
   */
  const retireDream = async (id, reason, outcome) => {
    const dream = cache.dreams.get(id)
    if (dream === undefined) throw new DreamError(`unknown dream: ${id}`, 'not-found')
    const entry = discardEntry(dream, reason, outcome)
    await putDiscard(entry)
    await cache.unit.deleteRecord('dreams', id)
    cache.dreams.delete(id)
    cache.meta.revision += 1
    return entry
  }

  /** Retire active stubs whose title exactly duplicates a pursued dream. */
  const cleanupPursuedStubs = async () => {
    const byTitle = new Map()
    for (const entry of cache.discards) {
      if (entry?.outcome === 'pursued') byTitle.set(normalizeTitle(entry.title), entry)
    }
    let retired = 0
    for (const dream of [...cache.dreams.values()]) {
      if (!isDreamStub(dream)) continue
      if (!byTitle.has(normalizeTitle(dream.title))) continue
      await retireDream(dream.id, 'auto-retired: duplicate of a pursued dream, no content', 'retired')
      retired += 1
    }
    if (retired > 0) await persistMeta()
  }

  /** List the active board in review order. */
  const listDreams = () => [...cache.dreams.values()].sort(byReviewPriority)

  /** Pursued dreams, newest first. */
  const pursuedEntries = () => cache.discards
    .filter(entry => entry?.outcome === 'pursued')
    .sort((left, right) => String(right.date).localeCompare(String(left.date)))

  /**
   * Active dreams that duplicate a pursued concept.
   * @returns warning rows for the Dreamer context.
   */
  const pursuedWarnings = () => {
    const byTitle = new Map()
    for (const entry of pursuedEntries()) byTitle.set(normalizeTitle(entry.title), entry)
    const warnings = []
    for (const dream of listDreams()) {
      const match = byTitle.get(normalizeTitle(dream.title))
      if (match === undefined) continue
      warnings.push({
        id: dream.id,
        title: dream.title,
        pursued: match.title,
        kind: isDreamStub(dream) ? 'stub-duplicate' : 'title-duplicate',
        action: isDreamStub(dream) ? 'retire it: it has no content beyond a copied pitch' : 'sharpen it or retire it; it duplicates pursued work',
      })
    }
    return warnings
  }

  /**
   * Find the ledger entries that match one dream's identity or concept.
   *
   * Identity wins over fuzzy similarity: an exact normalized title, or a pitch
   * copied nearly verbatim, is decisive even when the rest of a stub is empty
   * and the token score would fall below the threshold.
   * @param dream - candidate dream.
   * @param excludeId - dream id to ignore when refining itself.
   * @returns up to eight matches, strongest first.
   */
  const similarDiscards = (dream, excludeId) => {
    const tokens = dreamTokens(dream)
    const title = normalizeTitle(dream.title)
    const pitchTokens = conceptTokens(dream.pitch)
    const matches = []
    for (const entry of cache.discards) {
      if (entry === undefined || !Array.isArray(entry.tokens)) continue
      if (excludeId !== undefined && entry.dreamId === excludeId) continue
      let match = null
      if (title !== '' && normalizeTitle(entry.title) === title) {
        match = { match: 'same-title', score: 1 }
      } else if (pitchTokens.length >= 4) {
        const overlap = tokenOverlap(pitchTokens, conceptTokens(typeof entry.summary === 'string' ? entry.summary : ''))
        if (overlap.score >= 0.8 && overlap.shared >= 4) match = { match: 'same-pitch', score: overlap.score }
      }
      if (match === null) {
        const { score, shared } = tokenSimilarity(tokens, entry.tokens)
        if (score >= SIMILARITY_THRESHOLD && shared >= SIMILARITY_MIN_SHARED) match = { match: 'concept-overlap', score }
      }
      if (match === null) continue
      matches.push({
        id: entry.id,
        dreamId: entry.dreamId,
        title: entry.title,
        outcome: entry.outcome,
        reason: entry.reason,
        match: match.match,
        score: Math.round(match.score * 100) / 100,
      })
    }
    matches.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    return matches.slice(0, 8)
  }

  /**
   * Find the active dreams that match one candidate by identity or concept.
   * @param dream - candidate dream.
   * @param excludeId - dream id to ignore when refining itself.
   * @returns up to five matches.
   */
  const similarDreams = (dream, excludeId) => {
    const tokens = dreamTokens(dream)
    const title = normalizeTitle(dream.title)
    const pitchTokens = conceptTokens(dream.pitch)
    const matches = []
    for (const active of cache.dreams.values()) {
      if (active.id === excludeId) continue
      let match = null
      if (title !== '' && normalizeTitle(active.title) === title) match = { match: 'same-title', score: 1 }
      else if (pitchTokens.length >= 4) {
        const overlap = tokenOverlap(pitchTokens, conceptTokens(active.pitch))
        if (overlap.score >= 0.8 && overlap.shared >= 4) match = { match: 'same-pitch', score: overlap.score }
      }
      if (match === null) {
        const { score, shared } = tokenSimilarity(tokens, dreamTokens(active))
        if (score >= SIMILARITY_THRESHOLD && shared >= SIMILARITY_MIN_SHARED) match = { match: 'concept-overlap', score }
      }
      if (match === null) continue
      matches.push({ id: active.id, title: active.title, status: active.status, match: match.match, score: Math.round(match.score * 100) / 100 })
    }
    matches.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    return matches.slice(0, 5)
  }

  /** Acquire or inspect the run lock for one session. */
  const touchLock = async (sessionId) => serialize(async () => {
    const now = Date.now()
    const lock = cache.meta.lock
    if (lock !== null && typeof lock === 'object' && lock.sessionId !== sessionId && now - lock.at < LOCK_TTL_MS) {
      return { heldByOther: true, since: lock.at }
    }
    cache.meta.lock = { sessionId, at: now }
    await persistMeta()
    return { heldByOther: false }
  })

  /** Release the run lock when this session owns it. */
  const releaseLock = async (sessionId) => {
    if (cache.meta.lock?.sessionId !== sessionId) return
    cache.meta.lock = null
    await persistMeta()
  }

  /** Build the ingest payload for one run. */
  const context = async (sessionId) => {
    await open()
    const ideas = await readIdeas()
    const lock = sessionId === undefined ? { heldByOther: false } : await touchLock(sessionId)
    const sessions = await sessionDigest(ctx)
    const activity = await activityDigest(sessions, {
      projectCwd: resolveProjectCwd(),
      home: config.activityHome,
      excludeId: sessionId,
    })
    return {
      locked: lock.heldByOther,
      lockSince: typeof lock.since === 'number' ? lock.since : null,
      caps: {
        maxActiveDreams: config.maxActiveDreams,
        maxNewDreamsPerRun: config.maxNewDreamsPerRun ?? 1,
        maxWebCalls: config.maxWebCalls,
        maxSubagents: config.maxSubagents,
      },
      rubric: RUBRIC,
      ideas: ideas.map((item) => ({ id: item.id, text: item.text, done: item.done === true, createdAt: item.createdAt })),
      sessions,
      activity,
      dreams: listDreams().map(compactDream),
      pursued: pursuedEntries().slice(0, 40).map(compactPursued),
      discards: cache.discards.filter(entry => entry?.outcome !== 'pursued').slice(-30).map(compactLedgerEntry),
      boardWarnings: pursuedWarnings(),
      lastRuns: cache.runs.slice(0, 3).map((run) => ({
        at: run.at, added: run.added, refined: run.refined, note: text(run.note, 200),
      })),
      counts: { dreams: cache.dreams.size, discards: cache.discards.length, pursued: pursuedEntries().length },
      schedule: await scheduleState(),
    }
  }

  /**
   * Record a run that failed before writing its summary, and release its lock.
   * @param sessionId - failed run identity.
   * @param reason - short failure description.
   * @returns the run record.
   */
  const recordFailure = async (sessionId, reason) => serialize(async () => {
    await open()
    const run = {
      id: `run_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      at: Date.now(),
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      added: [], refined: [], promoted: [], retired: [], skipped: [],
      note: `Run failed: ${text(reason, 600) || 'unknown error'}`,
    }
    await putRun(run)
    if (typeof sessionId === 'string') cache.runAdditions.delete(sessionId)
    await releaseLock(sessionId)
    await persistMeta()
    return run
  })

  /**
   * Save a new or refined dream, enforcing the cap and discard dedup.
   * @param input - dream fields, the change note, merged ids, and a distinction.
   * @param sessionId - calling run identity.
   * @returns the saved dream or a structured rejection.
   */
  const save = async (input, sessionId) => serialize(async () => {
    await open()
    const now = Date.now()
    const previous = typeof input.id === 'string' ? cache.dreams.get(input.id) : undefined
    const requestedId = typeof input.id === 'string' ? input.id.trim() : ''
    if (requestedId !== '' && previous === undefined) {
      return {
        ok: false,
        code: 'unknown-id',
        message: `Unknown dream id "${requestedId}". Omit id to create a new dream, or use an id from dream_context/dream_get.`,
      }
    }
    if (previous !== undefined) {
      const declaredTitle = text(input.title, 200)
      if (declaredTitle === '') {
        return {
          ok: false,
          code: 'target-required',
          message: 'When refining, include the target `title` with `id` so a mistyped id cannot overwrite another dream.',
        }
      }
      if (normalizeTitle(declaredTitle) !== normalizeTitle(previous.title)) {
        return {
          ok: false,
          code: 'target-mismatch',
          message: `Dream ${previous.id} is "${previous.title}", not "${declaredTitle}". Use dream_get for the correct id and title.`,
        }
      }
    }
    const dream = normalizeDream(input, previous, now)
    if (dream.title === '' || dream.pitch === '') throw new DreamError('a dream needs a title and a one-line pitch', 'invalid')
    const duplicates = similarDiscards(dream, previous?.id)
    if (duplicates.length > 0 && text(input.distinction, 600) === '') {
      return {
        ok: false,
        code: 'duplicate',
        message: 'This matches a pursued, discarded, or retired dream (see `match`). Pursued work is binding: pick a materially different concept, or supply `distinction` stating how it differs.',
        similar: duplicates,
      }
    }
    const nearActive = similarDreams(dream, previous?.id)
    const mergedIds = new Set(Array.isArray(input.mergedFrom) ? input.mergedFrom.filter((id) => typeof id === 'string') : [])
    if (previous === undefined && nearActive.length > 0 && text(input.distinction, 600) === ''
      && !nearActive.some((match) => mergedIds.has(match.id))) {
      return {
        ok: false,
        code: 'duplicate-active',
        message: 'This matches an active dream. Refine that dream by id, merge it with `mergedFrom`, or supply `distinction` if it is a materially different take.',
        similar: nearActive,
      }
    }
    const activeCount = cache.dreams.size
    if (previous === undefined && activeCount >= config.maxActiveDreams) {
      return {
        ok: false,
        code: 'cap',
        message: `The active board is at its cap (${config.maxActiveDreams}). Retire a weak dream before adding another.`,
      }
    }
    if (previous === undefined && (text(dream.problem, 1) === '' || text(dream.targetUser, 1) === '')) {
      return {
        ok: false,
        code: 'thin',
        message: 'Quality over quantity: a new dream needs a specific problem and target user before it joins the board. Build the case first, or deepen an existing dream.',
      }
    }
    const change = text(input.change, 600) || (previous === undefined ? 'Initial draft' : 'Refined')
    if (previous !== undefined) {
      dream.iterationCount = previous.iterationCount + 1
      dream.status = input.status === 'ready_for_review' ? 'ready_for_review' : previous.status === 'ready_for_review' ? 'ready_for_review' : 'incubating'
      dream.revisionLog.push({ at: now, change })
    } else {
      dream.revisionLog.push({ at: now, change })
    }
    if (text(input.distinction, 600) !== '') {
      dream.distinction = text(input.distinction, 600)
      dream.revisionLog.push({ at: now, change: `Distinction from discard memory: ${dream.distinction}` })
    }
    const ready = isReady(dream)
    if (ready) {
      if (dream.status !== 'ready_for_review') {
        dream.status = 'ready_for_review'
        dream.revisionLog.push({ at: now, change: 'Promoted to ready_for_review (review bar met)' })
      }
    } else if (dream.status === 'ready_for_review' && previous === undefined) {
      dream.status = 'incubating'
    }
    const createdThisRun = sessionId === undefined ? 0 : (cache.runAdditions.get(sessionId) ?? 0)
    const newDreamCap = config.maxNewDreamsPerRun ?? 1
    if (previous === undefined && sessionId !== undefined && createdThisRun >= newDreamCap) {
      return {
        ok: false,
        code: 'run-cap',
        message: `Quality over quantity: this run already added ${createdThisRun} new dream(s) (cap ${newDreamCap}). Deepen an existing dream instead, or finish with dream_summary.`,
      }
    }
    await putDream(dream)
    if (previous === undefined && sessionId !== undefined) cache.runAdditions.set(sessionId, createdThisRun + 1)
    if (sessionId !== undefined) {
      const logged = cache.runSaves.get(sessionId) ?? { created: [], refined: [] }
      logged[previous === undefined ? 'created' : 'refined'].push(dream.title)
      cache.runSaves.set(sessionId, logged)
    }
    const merged = []
    if (Array.isArray(input.mergedFrom)) {
      for (const id of input.mergedFrom.slice(0, 5)) {
        if (typeof id !== 'string' || id === dream.id || !cache.dreams.has(id)) continue
        merged.push(await retireDream(id, `merged-into:${dream.id}`, 'retired'))
      }
    }
    await persistMeta()
    return { ok: true, dream, nearActive, merged: merged.map((entry) => entry.title), ready }
  })

  /** Build the active-board state for the UI and the schedule. */
  const state = async () => {
    await open()
    const schedule = await scheduleState()
    return {
      dreams: listDreams(),
      counts: { active: cache.dreams.size, ready: listDreams().filter((dream) => dream.status === 'ready_for_review').length, discards: cache.discards.length },
      caps: {
        maxActiveDreams: config.maxActiveDreams,
        maxNewDreamsPerRun: config.maxNewDreamsPerRun ?? 1,
        maxWebCalls: config.maxWebCalls,
        maxSubagents: config.maxSubagents,
      },
      rubric: RUBRIC,
      schedule,
      lastRun: cache.runs[0] ?? null,
      runs: cache.runs.slice(0, 6).map((run) => ({ at: run.at, added: run.added, refined: run.refined, promoted: run.promoted, retired: run.retired, skipped: run.skipped })),
    }
  }

  /** Read the managed dreamer schedule task. */
  const scheduleState = async () => {
    const schedule = ctx.get('schedule')
    if (schedule === undefined) return { available: false, task: null }
    try {
      const task = await ensureSchedule()
      return {
        available: true,
        task: task === null ? null : {
          id: task.id,
          status: task.status,
          scheduledAt: task.scheduledAt,
          title: task.title,
        },
      }
    } catch (error) {
      return { available: false, task: null, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Record the run summary and release the lock. */
  const summary = async (input, sessionId) => serialize(async () => {
    await open()
    const now = Date.now()
    const logged = sessionId === undefined ? { created: [], refined: [] } : cache.runSaves.get(sessionId) ?? { created: [], refined: [] }
    const actual = { added: [...new Set(logged.created)], refined: [...new Set(logged.refined)] }
    const run = {
      id: `run_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      at: now,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      added: stringList(input.added, 30, 200),
      refined: stringList(input.refined, 60, 200),
      promoted: stringList(input.promoted, 30, 200),
      retired: stringList(input.retired, 30, 200),
      skipped: stringList(input.skipped, 30, 300),
      note: text(input.note, 800),
      actual,
    }
    const sameSet = (claimed, recorded) => claimed.length === recorded.length && claimed.every(title => recorded.includes(title))
    const mismatch = !sameSet(run.added, actual.added) || !sameSet(run.refined, actual.refined)
    if (mismatch) run.mismatch = true
    await putRun(run)
    if (typeof sessionId === 'string') {
      cache.runAdditions.delete(sessionId)
      cache.runSaves.delete(sessionId)
    }
    await releaseLock(sessionId)
    await persistMeta()
    return mismatch
      ? { ...run, warning: 'The reported added/refined titles did not match the saves this session actually made; `actual` is authoritative.' }
      : run
  })

  /** Retire one dream to the ledger. */
  const retire = async (id, reason, outcome = 'retired') => {
    if (!DISCARD_OUTCOMES.includes(outcome)) throw new DreamError(`unknown outcome: ${outcome}`, 'invalid')
    const entry = await serialize(async () => {
      await open()
      const created = await retireDream(id, reason, outcome)
      await persistMeta()
      return created
    })
    return entry
  }

  /** Read one dream by id. */
  const get = (id) => cache.dreams.get(id)

  /** Resolve the project directory for Dreamer sessions and Fleet buildouts. */
  const resolveProjectCwd = () => {
    if (config.projectCwd !== '') return path.resolve(config.projectCwd)
    const registry = ctx.get('workspaceRegistry')
    const workspaces = typeof registry?.list === 'function' ? registry.list() : []
    let best
    for (const workspace of workspaces) {
      if (workspace === null || typeof workspace !== 'object' || typeof workspace.path !== 'string' || workspace.path === '') continue
      if (best === undefined || (workspace.sessionIds?.length ?? 0) > (best.sessionIds?.length ?? 0)) best = workspace
    }
    if (best !== undefined) return path.resolve(best.path)
    const workingDirectory = ctx.get('workingDirectory')
    const fallback = workingDirectory?.defaultDirectory
    return path.resolve(typeof fallback === 'string' && fallback !== '' ? fallback : process.cwd())
  }

  /** Launch a Fleet-mode session with one execution spec. */
  const launchFleet = async (spec, title, cwd = resolveProjectCwd()) =>
    launchFleetSession(ctx, { title: `Dream buildout: ${title}`, prompt: spec, cwd })

  /** Dreams with a launch in flight, so a double click starts one buildout. */
  const pursuing = new Set()

  /** Build the public packet summary returned to commands and routes. */
  const packetSummary = (dream, written) => ({
    title: dream.title,
    dreamId: dream.id,
    briefPath: written.briefRelativePath,
    checksPath: written.checksRelativePath,
    templatePath: written.templateRelativePath,
    checkCount: written.checks.length,
    unresolvedSlots: written.unresolvedSlots,
    absoluteBriefPath: written.briefPath,
    absoluteChecksPath: written.checksPath,
  })

  /** Write one dream's build packet, wrapping filesystem failures clearly. */
  const writePacket = async (dream, options = {}) => {
    try {
      return await writeBrief({
        dream,
        cwd: resolveProjectCwd(),
        outDir: typeof options.outDir === 'string' && options.outDir !== '' ? options.outDir : 'briefs',
        templatePath: typeof options.templatePath === 'string' && options.templatePath !== '' ? options.templatePath : undefined,
      })
    } catch (error) {
      throw new DreamError(`build packet could not be written: ${error instanceof Error ? error.message : String(error)}`, 'brief-failed')
    }
  }

  /** Render and write one dream's build packet without starting a session. */
  const brief = async (id, options = {}) => {
    await open()
    const dream = cache.dreams.get(id)
    if (dream === undefined) throw new DreamError(`unknown dream: ${id}`, 'not-found')
    const written = await writePacket(dream, options)
    return packetSummary(dream, written)
  }

  /** Pursue one dream: write the packet, launch Fleet with it, then move it to the ledger. */
  const pursue = async (id, options = {}) => {
    await open()
    if (pursuing.has(id)) throw new DreamError('this dream is already starting a buildout', 'busy')
    pursuing.add(id)
    try {
      const dream = cache.dreams.get(id)
      if (dream === undefined) throw new DreamError(`unknown dream: ${id}`, 'not-found')
      const written = await writePacket(dream, options)
      const spec = buildFleetPrompt(written)
      const launch = await launchFleet(spec, dream.title, written.root)
      await serialize(async () => {
        const reason = `pursued: fleet buildout started${launch.sessionId === null ? '' : ` (${launch.sessionId})`} — packet ${written.briefRelativePath}`
        const entry = await retireDream(id, reason, 'pursued')
        await persistMeta()
        return entry
      })
      return { ...launch, ...packetSummary(dream, written) }
    } finally {
      pursuing.delete(id)
    }
  }

  /** Discard one dream with an optional one-line reason. */
  const discard = async (id, reason) => {
    await open()
    const dream = cache.dreams.get(id)
    if (dream === undefined) throw new DreamError(`unknown dream: ${id}`, 'not-found')
    const entry = await serialize(async () => {
      const created = await retireDream(id, reason === '' ? 'discarded by user' : reason, 'discarded')
      await persistMeta()
      return created
    })
    return { title: dream.title, id: entry.id }
  }

  /** Ensure the managed dreamer schedule task exists and matches this config. */
  const ensureSchedule = async () => {
    await open()
    const schedule = ctx.get('schedule')
    if (schedule === undefined) return null
    const cwd = resolveProjectCwd()
    const target = { kind: 'new', create: { agentPreset: 'dreamer', cwd } }
    // Include the prompt in the signature: a changed RUN_PROMPT must reach the
    // managed task, not wait for a schedule/time edit.
    const promptFingerprint = createHash('sha256').update(RUN_PROMPT).digest('hex').slice(0, 12)
    const signature = `${config.dailyTime}|${config.timeZone}|${cwd}|${promptFingerprint}`
    const tasks = await schedule.catalog()
    let task = cache.meta.scheduleId === null ? undefined : tasks.find((candidate) => candidate.id === cache.meta.scheduleId)
    if (task === undefined || task === null) {
      task = tasks.find((candidate) => candidate.title === 'Dreamer run' && candidate.target?.create?.agentPreset === 'dreamer')
    }
    if (task === undefined || task === null) {
      task = await schedule.create({
        title: 'Dreamer run',
        prompt: RUN_PROMPT,
        timing: { kind: 'daily', daily: { time: config.dailyTime, time_zone: config.timeZone } },
        target,
      })
      cache.meta.scheduleId = task.id
      cache.meta.scheduleSignature = signature
      await persistMeta()
      return task
    }
    if (cache.meta.scheduleSignature !== signature) {
      const updated = await schedule.edit({
        id: task.id,
        action: 'update',
        patch: {
          prompt: RUN_PROMPT,
          timing: { kind: 'daily', daily: { time: config.dailyTime, time_zone: config.timeZone } },
          target,
        },
      })
      cache.meta.scheduleSignature = signature
      cache.meta.scheduleId = task.id
      await persistMeta()
      return Object.prototype.hasOwnProperty.call(updated, 'status') ? updated : task
    }
    if (cache.meta.scheduleId !== task.id) {
      cache.meta.scheduleId = task.id
      await persistMeta()
    }
    return task
  }

  /** Pause, resume, or run the dreamer schedule now. */
  const controlSchedule = async (action) => {
    await open()
    const schedule = ctx.get('schedule')
    if (schedule === undefined) throw new DreamError('the schedule service is unavailable', 'schedule-unavailable')
    const task = await ensureSchedule()
    if (task === null) throw new DreamError('the dreamer schedule could not be created', 'schedule-unavailable')
    if (action === 'pause' || action === 'resume') {
      const updated = await schedule.edit({ id: task.id, action: 'update', patch: { active: action === 'resume' } })
      return { action, task: updated }
    }
    if (action === 'run') {
      const result = await schedule.run({ id: task.id })
      if (result !== null && typeof result === 'object' && result.code === 'schedule_execution_pending') {
        throw new DreamError('a dreamer run is already active', 'busy')
      }
      return { action, sessionId: result?.lastDelivery?.targetSessionId ?? null, task: result }
    }
    throw new DreamError(`unknown schedule action: ${action}`, 'invalid')
  }

  /** Close every unit on unload. */
  const close = () => {
    const units = [cache.unit, cache.discardsUnit, cache.runsUnit].filter((unit) => unit !== null)
    cache.unit = null
    cache.discardsUnit = null
    cache.runsUnit = null
    cache.meta = null
    return Promise.allSettled(units.map((unit) => unit.close()))
  }

  return {
    open, close, context, state, save, summary, retire, discard, brief, pursue, get, listDreams,
    ensureSchedule, controlSchedule, scheduleState, recordFailure,
  }
}

/** The static instruction delivered to every scheduled dreamer session. */
export const RUN_PROMPT = [
  'Run the Dreamer loop now. Work in this order and stop when the run is complete. Quality over quantity: a smaller, sharper board beats more rows.',
  '',
  '1. Call `dream_context` first. If it reports `locked: true`, another run is active: do not write anything and stop.',
  '   Read `activity` before ideating: deterministic receipts for recent sessions (files added/modified/deleted, commands with exit codes, open threads, models, cost) plus a `rollup` of recurring files, failures, and repeated open threads. Use it as evidence of real friction, never as a source of titles.',
  '   `pursued` is binding history: those concepts were already shipped or started. Never add them again under the same title, a copied pitch, or a thin restatement. `discards` is supporting history.',
  '2. Reconcile the board first. Retire every `boardWarnings` entry of kind `stub-duplicate` with `dream_retire` (reason "dreamer-retired"); for `title-duplicate`, either sharpen the active dream until it clearly differs or retire it. Then call `dream_get` for at most two active dreams (the lowest score or the most `missing` sections) and deepen only those, filling missing sections in order. The context index is compact on purpose; fetch full specs only for dreams you will change. Refine with both the `id` and the exact `title`; an unknown id or mismatched title is rejected, so never invent an id or reuse another dream\'s id.',
  '3. Add at most `caps.maxNewDreamsPerRun` new dream (default 1), and only when it is clearly stronger than the weakest active dream and grounded in `activity` or `recentUserMessages`: a command that keeps failing across sessions, an area repeatedly rewritten, a thread left open, or a workflow the user repeats. Do not build a dream around a one-off error, a typo, or a transient path problem. If nothing clears that bar, add none and say so in the summary. Never re-add a pursued concept; if your idea overlaps one, drop it or choose a materially different angle and state the distinction.',
  '4. Research only what the change needs: use `web_search`/`web_fetch` for market gaps, competitor pricing, and feasibility, and `subagent` for parallel angles when it saves time. Do not research a dream you will not save. Attach sources; when a receipt informed the problem, list its session id in `sources.sessions`. Respect the `caps` from `dream_context`.',
  '5. Dedup every new, refined, or merged dream against `pursued`, `discards`, and the active board before saving. If `dream_save` returns `duplicate`, `unknown-id`, `target-required`, or `target-mismatch`, correct the call with an id and title from `dream_context`/`dream_get`; do not guess. Never use `distinction` to smuggle a pursued idea back in.',
  '6. Finish with `dream_summary` listing added / refined / promoted / retired / skipped-as-duplicate titles. List only what you actually saved; the store records the real saves in `actual` and flags a mismatched narrative. Include what you deliberately did not add and why. Do not finish without it.',
  '',
  'Quality bar: every dream names a specific user, a specific problem, and why existing solutions fall short. Reject generic ideas ("AI-powered X for everyone"). Score each dimension 1-5 honestly; a new dream that scores below the board median is not worth adding.',
  'You may read the idea board, pursued history, session activity, and one dream at a time through `dream_context` and `dream_get`, search the web, and spawn subagents. You may write only through `dream_save`, `dream_retire`, and `dream_summary`; never modify ideas, session history, or project code.',
].join('\n')

/**
 * Build a bounded digest of recent session history.
 * @param ctx - plugin context.
 * @returns recent non-delegated sessions with titles and recent user messages.
 */
async function sessionDigest(ctx) {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return []
  try {
    const records = (await query.listSessions()).filter((record) => record.header.origin !== 'subagent' && record.header.isSeeded !== true).slice(0, 6)
    const ids = records.map((record) => record.header.id)
    const titles = await query.readTitleSnapshots(ids)
    const titleById = new Map()
    for (const result of titles) {
      if (result.status === 'fulfilled' && result.value.title !== undefined) titleById.set(result.sessionId, result.value.title.title)
    }
    const digest = []
    for (const record of records) {
      let messages = []
      try {
        const docs = await query.filterEvents(record.header.id, [{ kind: 'type', values: ['user/message'] }])
        messages = docs
          .map((doc) => String(doc.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240))
          .filter((entry) => entry !== '' && !NOISE_PREFIX.some((prefix) => entry.toLowerCase().startsWith(prefix.toLowerCase())))
          .slice(-4)
      } catch (error) {
        console.warn('idea-board: session history read failed', error)
      }
      digest.push({
        id: record.header.id,
        title: titleById.get(record.header.id) ?? '(untitled)',
        cwd: record.header.cwd ?? '',
        createdAt: record.header.createdAt,
        recentUserMessages: messages,
      })
    }
    return digest
  } catch (error) {
    console.warn('idea-board: session digest failed', error)
    return []
  }
}

