/**
 * Pursued-history guardrails: a shipped concept cannot come back as a stub,
 * the per-run new-dream cap holds, and the Dreamer context stays compact.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createDreamBoard, dreamTokens, normalizeTitle } from '../dreams.js'

/** A storage unit over in-memory tables. */
function unit(tables) {
  return {
    tables,
    async loadAll() { return { tables } },
    async putRecord(table, key, value) { (tables[table] ??= {})[key] = value },
    async deleteRecord(table, key) { if (tables[table] !== undefined) delete tables[table][key] },
    async deleteRecords(table, keys) { for (const key of keys) delete tables[table]?.[key] },
    async close() {},
  }
}

/**
 * Build a board over in-memory storage.
 * @param {{cwd: string, activityHome: string, dreams?: object, discards?: object}} options - fixture coordinates.
 * @returns {{board: object, units: object}} the board and its tables.
 */
function makeBoard(options) {
  const units = {
    dream_board: unit({
      dreams: options.dreams ?? {},
      meta: { current: { version: 1, revision: 1, scheduleId: null, scheduleSignature: null, lock: null } },
    }),
    dream_discards: unit({ entries: options.discards ?? {} }),
    dream_runs: unit({ runs: {} }),
  }
  const ctx = {
    get(name) {
      if (name !== 'storage') return undefined
      return { backend: { names: () => ['json'], get: () => ({ kv: { open: async (descriptor) => units[descriptor.name] } }) } }
    },
  }
  const board = createDreamBoard(ctx, {
    maxActiveDreams: 10,
    maxNewDreamsPerRun: 1,
    maxWebCalls: 12,
    maxSubagents: 3,
    projectCwd: options.cwd,
    activityHome: options.activityHome,
  }, async () => [])
  return { board, units }
}

/** A complete dream used as the pursued concept. */
const FULL = {
  title: 'Session Diff',
  pitch: 'A per-session receipt for DeepSeek Harness: files changed, commands, models, cost, and open threads, generated from events.',
  type: 'feature',
  problem: 'Returning to a workspace after an unattended session means scrolling a transcript.',
  targetUser: 'Harness power users who leave scheduled sessions running.',
  value: 'One deterministic artifact replaces transcript archaeology.',
  architecture: 'Host plugin plus a thin CLI over the session event stream.',
  mvpScope: ['Read the session log', 'Hash changed files', 'Render a receipt'],
  competitive: { summary: 'Git misses non-repo state.', competitors: [{ name: 'git diff', url: '', pricing: 'free', gap: 'no session boundary' }] },
  monetization: 'n/a',
  effort: '2 weeks',
  tags: ['harness', 'receipts'],
  scores: { value: 4, niche: 4, revenue: 1, feasibility: 5, fit: 5 },
}

/**
 * Build a pursued ledger entry for a dream.
 * @param {object} dream - saved dream.
 * @returns {object} the entry.
 */
function pursuedEntry(dream) {
  return {
    id: `dsc_${dream.id}`,
    dreamId: dream.id,
    title: dream.title,
    summary: dream.pitch,
    mechanics: { problem: dream.problem, targetUser: dream.targetUser, approach: dream.architecture },
    tags: dream.tags,
    reason: 'pursued: fleet buildout started (session-test) — packet briefs/session-diff.md',
    outcome: 'pursued',
    date: new Date().toISOString(),
    tokens: dreamTokens(dream),
  }
}

/**
 * Save a full dream and move it to the pursued ledger.
 * @param {object} board - board instance.
 * @returns {Promise<object>} the ledged dream.
 */
async function seedPursued(board) {
  const saved = await board.save({ ...FULL, change: 'Initial draft' }, 'session-seed')
  assert.equal(saved.ok, true)
  await board.retire(saved.dream.id, 'pursued: fleet buildout started (session-test) — packet briefs/session-diff.md', 'pursued')
  return saved.dream
}

test('a stub that copies a pursued title and pitch is rejected by identity', async () => {
  const { board } = makeBoard({ cwd: process.cwd(), activityHome: process.cwd() })
  await seedPursued(board)
  const result = await board.save({
    title: 'Session Diff',
    pitch: FULL.pitch,
    architecture: 'New architecture prose that dilutes token similarity.',
    mvpScope: ['one', 'two'],
    change: 'Restored Session Diff.',
  }, 'session-run')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'duplicate')
  assert.equal(result.similar[0].match, 'same-title')
  assert.equal(result.similar[0].outcome, 'pursued')
})

test('a renamed copy of a pursued pitch is rejected by pitch identity', async () => {
  const { board } = makeBoard({ cwd: process.cwd(), activityHome: process.cwd() })
  await seedPursued(board)
  const result = await board.save({
    title: 'Session Ledger',
    pitch: FULL.pitch,
    architecture: 'Different words.',
    mvpScope: ['one'],
    change: 'A different framing.',
  }, 'session-run')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'duplicate')
  assert.equal(result.similar[0].match, 'same-pitch')
})

test('a stub that copies an active dream is rejected by identity without a distinction', async () => {
  const { board } = makeBoard({ cwd: process.cwd(), activityHome: process.cwd() })
  const first = await board.save({ ...FULL, change: 'Initial draft' }, 'session-seed')
  assert.equal(first.ok, true)
  const stub = await board.save({
    title: 'Session Diff',
    pitch: 'A different pitch that does not copy the original wording at all.',
    architecture: 'New architecture prose.',
    change: 'A parallel version.',
  }, 'session-run')
  assert.equal(stub.ok, false)
  assert.equal(stub.code, 'duplicate-active')
  assert.equal(stub.similar[0].match, 'same-title')
})

test('refining requires the target title and rejects a mistyped id', async () => {
  const { board } = makeBoard({ cwd: process.cwd(), activityHome: process.cwd() })
  const saved = await board.save({ ...FULL, change: 'Initial draft' }, 'session-seed')
  assert.equal(saved.ok, true)
  const id = saved.dream.id

  const noTitle = await board.save({ id, problem: 'Sharpened problem.', change: 'Deepen' }, 'session-run')
  assert.equal(noTitle.ok, false)
  assert.equal(noTitle.code, 'target-required')

  const wrongTitle = await board.save({ id, title: 'Session Tripwire', problem: 'Sharpened problem.', change: 'Deepen' }, 'session-run')
  assert.equal(wrongTitle.ok, false)
  assert.equal(wrongTitle.code, 'target-mismatch')

  const invented = await board.save({ id: 'drm_session_diff', title: 'Session Diff', pitch: FULL.pitch, problem: 'P', targetUser: 'U', change: 'Restore' }, 'session-run')
  assert.equal(invented.ok, false)
  assert.equal(invented.code, 'unknown-id')

  const corrected = await board.save({ id, title: FULL.title, problem: 'Sharpened problem.', change: 'Deepen' }, 'session-run')
  assert.equal(corrected.ok, true)
  assert.equal(corrected.dream.id, id)
})

test('dream_summary records the actual saves and flags a mismatched narrative', async () => {
  const { board } = makeBoard({ cwd: process.cwd(), activityHome: process.cwd() })
  const created = await board.save({
    title: 'Alpha Exporter',
    pitch: 'Batch export schedules for accounting teams filing quarterly returns.',
    problem: 'Accounting teams rebuild export schedules by hand each quarter.',
    targetUser: 'Small accounting firms filing quarterly returns.',
    value: 'One schedule definition drives every export.',
    change: 'First',
  }, 'session-run')
  assert.equal(created.ok, true)
  const summary = await board.summary({ added: ['A Dream That Was Never Saved'], refined: ['Session Diff'] }, 'session-run')
  assert.equal(summary.mismatch, true)
  assert.match(summary.warning, /actual/)
  assert.deepEqual(summary.actual.added, ['Alpha Exporter'])
  assert.deepEqual(summary.actual.refined, [])
})

test('a thin new dream is rejected before it reaches the board', async () => {
  const { board } = makeBoard({ cwd: process.cwd(), activityHome: process.cwd() })
  const result = await board.save({
    title: 'Idea Without A Case',
    pitch: 'A short pitch with no problem or user behind it.',
    change: 'Initial draft',
  }, 'session-run')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'thin')
})

test('a per-run cap keeps a run to one new dream', async () => {
  const { board } = makeBoard({ cwd: process.cwd(), activityHome: process.cwd() })
  const substance = {
    problem: 'Accounting teams rebuild export schedules by hand each quarter.',
    targetUser: 'Small accounting firms filing quarterly returns.',
    value: 'One schedule definition drives every export.',
  }
  const first = await board.save({ title: 'Alpha Exporter', pitch: 'Batch export schedules for accounting teams filing quarterly returns.', ...substance, change: 'First' }, 'session-run')
  assert.equal(first.ok, true)
  const second = await board.save({
    title: 'Marine Notebook',
    pitch: 'Field notes and species counts for marine biologists on small boats.',
    problem: 'Marine surveys lose counts across paper sheets.',
    targetUser: 'Marine biologists on small boats.',
    value: 'One reliable field notebook.',
    change: 'Second',
  }, 'session-run')
  assert.equal(second.ok, false)
  assert.equal(second.code, 'run-cap')
  const otherRun = await board.save({
    title: 'Marine Notebook',
    pitch: 'Field notes and species counts for marine biologists on small boats.',
    problem: 'Marine surveys lose counts across paper sheets.',
    targetUser: 'Marine biologists on small boats.',
    value: 'One reliable field notebook.',
    change: 'Second',
  }, 'session-other')
  assert.equal(otherRun.ok, true)
})

test('the context carries a compact board index, pursued history, and no full specs', async () => {
  const { board } = makeBoard({ cwd: process.cwd(), activityHome: process.cwd() })
  await seedPursued(board)
  const context = await board.context('session-run')
  assert.equal(context.pursued.length, 1)
  assert.equal(context.pursued[0].title, 'Session Diff')
  assert.equal(context.pursued[0].packet, 'briefs/session-diff.md')
  assert.equal(context.pursued[0].session, 'session-test')
  assert.equal(context.counts.pursued, 1)
  assert.equal(context.discards.length, 0)
  const active = await board.save({
    title: 'Alpha Tool',
    pitch: 'A unique first idea about alpha workflows.',
    problem: 'Alpha teams rebuild the same checklist every week.',
    targetUser: 'Alpha team leads.',
    change: 'First',
  }, 'session-run')
  assert.equal(active.ok, true)
  const next = await board.context('session-run')
  assert.ok(next.dreams.length >= 1)
  assert.equal(next.dreams[0].architecture, undefined)
  assert.ok(Array.isArray(next.dreams[0].missing))
  assert.ok(next.dreams[0].missing.includes('architecture'))
})

test('opening the board retires an active stub that duplicates a pursued dream', async () => {
  const stub = {
    id: 'drm_stub', title: 'Session Diff', pitch: FULL.pitch, type: 'feature',
    problem: '', targetUser: '', value: '', architecture: '', mvpScope: [], competitive: { summary: '', competitors: [] },
    monetization: '', effort: '', tags: [], scores: { value: 1, niche: 1, revenue: 1, feasibility: 1, fit: 1 },
    totalScore: 5, iterationCount: 0, status: 'incubating', createdAt: 1, lastRefinedAt: 1, revisionLog: [], distinction: '',
  }
  const entry = pursuedEntry({ ...stub, tokens: dreamTokens(stub) })
  const { board, units } = makeBoard({
    cwd: process.cwd(),
    activityHome: process.cwd(),
    dreams: { [stub.id]: stub },
    discards: { [entry.id]: entry },
  })
  const context = await board.context('session-run')
  assert.equal(units.dream_board.tables.dreams[stub.id], undefined)
  assert.deepEqual(context.boardWarnings, [])
  const retired = Object.values(units.dream_discards.tables.entries).filter(row => row.outcome === 'retired')
  assert.equal(retired.length, 1)
  assert.match(retired[0].reason, /auto-retired/)
  assert.equal(normalizeTitle(retired[0].title), normalizeTitle('Session Diff'))
})
