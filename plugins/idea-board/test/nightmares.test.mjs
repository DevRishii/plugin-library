/**
 * Unit tests for the nightmare board: the backlog of dsh-doctor findings that
 * wait for an explicit approver decision.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NIGHTMARE_ACTIONS,
  NIGHTMARE_STATUSES,
  NightmareError,
  buildSquashPrompt,
  createNightmareBoard,
  fingerprintOf,
  normalizeFinding,
} from '../nightmares.js'

/**
 * Build one storage unit over in-memory tables.
 * @param tables - table map mutated in place.
 * @returns the unit.
 */
function unit(tables) {
  return {
    tables,
    async loadAll() { return { tables } },
    async putRecord(table, key, value) { (tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { if (tables[table] !== undefined) delete tables[table][key] },
    async close() {},
  }
}

/**
 * Create a board over an in-memory backend.
 * @returns the board and its tables.
 */
function board() {
  const tables = { nightmares: {}, meta: {} }
  const ctx = {
    get(name) {
      if (name !== 'storage') return undefined
      return {
        backend: {
          names: () => ['json'],
          get: () => ({ kv: { open: async () => unit(tables) } }),
        },
      }
    },
  }
  return { board: createNightmareBoard(ctx, {}), tables }
}

/** One doctor finding for a failing check. */
function finding(overrides = {}) {
  return {
    id: 'plugin.duplicate-id',
    group: 'plugin',
    severity: 'error',
    title: 'Unique plugin ids',
    status: 'fail',
    summary: '1 plugin ids are provided by more than one package',
    evidence: [{ path: 'turn-cost/package.json', detail: '@local/turn-cost is also declared by turn-cost.backup-20261110' }],
    fix: { type: 'manual', summary: 'remove or rename the duplicate package', steps: ['keep one of them'] },
    ...overrides,
  }
}

test('the exported vocabulary is stable', () => {
  assert.deepEqual(NIGHTMARE_STATUSES, ['open', 'accepted', 'fixed', 'ignored', 'removed'])
  assert.deepEqual(NIGHTMARE_ACTIONS, ['accept', 'fix', 'ignore', 'remove', 'reopen'])
})

test('a fingerprint pins the check and its evidence so a rescan updates in place', () => {
  const one = normalizeFinding(finding())
  const two = normalizeFinding(finding())
  assert.equal(one.fingerprint, two.fingerprint)
  const moved = normalizeFinding(finding({ evidence: [{ path: 'other/package.json' }] }))
  assert.notEqual(one.fingerprint, moved.fingerprint)
  assert.equal(fingerprintOf('a.b', []), 'a.b|')
})

test('normalizeFinding rejects a finding with no check id and drops a malformed fix', () => {
  assert.throws(() => normalizeFinding({ summary: 'x' }), (error) => error instanceof NightmareError && error.code === 'invalid')
  const normalized = normalizeFinding(finding({ fix: { type: 'nonsense' } }))
  assert.equal(normalized.fix, null)
})

test('ingest adds a new nightmare as open and counts its occurrences on a rescan', async () => {
  const { board: store } = board()
  const first = await store.ingest({ findings: [finding()] })
  assert.deepEqual({ added: first.added, updated: first.updated }, { added: 1, updated: 0 })

  const [nightmare] = await store.list()
  assert.equal(nightmare.status, 'open')
  assert.equal(nightmare.checkId, 'plugin.duplicate-id')
  assert.equal(nightmare.occurrences, 1)
  assert.equal(nightmare.evidence.length, 1)

  const second = await store.ingest({ findings: [finding()] })
  assert.deepEqual({ added: second.added, updated: second.updated }, { added: 0, updated: 1 })
  const [again] = await store.list()
  assert.equal(again.occurrences, 2)
  assert.equal(again.id, nightmare.id, 'a rescan must not create a second entry')
})

test('pass and skip findings are not ingested', async () => {
  const { board: store } = board()
  const result = await store.ingest({
    findings: [
      finding({ status: 'pass', summary: 'unique ids' }),
      finding({ id: 'state.orphaned-lock', status: 'skip', summary: 'no .dsh directory' }),
    ],
  })
  assert.equal(result.added, 0)
  assert.equal(result.submitted, 2)
  assert.equal((await store.list()).length, 0)
})

test('a passing check clears the open nightmare for that check', async () => {
  const { board: store } = board()
  await store.ingest({ findings: [finding()] })
  const cleared = await store.ingest({
    findings: [finding({ status: 'pass', summary: '8 plugin manifests declare unique ids', evidence: [], fix: null })],
  })
  assert.equal(cleared.cleared, 1)
  const [nightmare] = await store.list()
  assert.equal(nightmare.status, 'fixed')
  assert.match(nightmare.decision.comment, /now passes/)
})

test('a compact feed that lists only defects still clears through the passing list', async () => {
  const { board: store } = board()
  await store.ingest({ findings: [finding()] })
  const cleared = await store.ingest({ findings: [], source: 'dsh-doctor', passing: ['plugin.duplicate-id'] })
  assert.equal(cleared.cleared, 1)
  const [nightmare] = await store.list()
  assert.equal(nightmare.status, 'fixed')
  await assert.rejects(store.ingest({ findings: [] }), (error) => error.code === 'invalid')
})

test('a cleared nightmare reopens when the finding returns', async () => {
  const { board: store } = board()
  await store.ingest({ findings: [finding()] })
  await store.ingest({ findings: [finding({ status: 'pass', evidence: [], fix: null })] })
  const again = await store.ingest({ findings: [finding()] })
  assert.equal(again.reopened, 1)
  const [nightmare] = await store.list()
  assert.equal(nightmare.status, 'open')
  assert.equal(nightmare.decision, null)
})

test('accept, fix, and reopen move a nightmare through its lifecycle', async () => {
  const { board: store } = board()
  await store.ingest({ findings: [finding()] })
  const [created] = await store.list()

  const accepted = await store.decide({ id: created.id, action: 'accept', comment: 'will fix this week' })
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.decision.action, 'accept')

  const fixed = await store.decide({ id: created.id, action: 'fix', comment: 'renamed the backup package' })
  assert.equal(fixed.status, 'fixed')
  assert.ok(fixed.resolvedAt > 0)

  const reopened = await store.decide({ id: created.id, action: 'reopen' })
  assert.equal(reopened.status, 'open', 'reopening is not a dismissal, so it needs no reason')
  assert.equal(reopened.resolvedAt, null)
})

test('squash marks a nightmare accepted and keeps the session id', async () => {
  const { board: store } = board()
  await store.ingest({ findings: [finding()] })
  const [created] = await store.list()

  const squashed = await store.beginSquash(created.id, 'session-abc')
  assert.equal(squashed.status, 'accepted')
  assert.equal(squashed.squashSessionId, 'session-abc')
  assert.match(squashed.decision.comment, /squash session started \(session-abc\)/)
  assert.equal(squashed.history.at(-1).to, 'accepted')

  await store.ingest({ findings: [finding()] })
  const [stillAccepted] = await store.list()
  assert.equal(stillAccepted.status, 'accepted', 'a rescan must not undo a repair in flight')

  await store.ingest({ findings: [finding({ status: 'pass', evidence: [], fix: null })] })
  const [closed] = await store.list()
  assert.equal(closed.status, 'fixed', 'only a passing check may call it fixed')
})

test('squash refuses an unknown nightmare', async () => {
  const { board: store } = board()
  await assert.rejects(store.beginSquash('nrm_missing', null), (error) => error.code === 'not-found')
})

test('the squash prompt names the finding, the evidence, and the check that must pass', () => {
  const nightmare = {
    checkId: 'plugin.duplicate-id',
    group: 'plugin',
    severity: 'error',
    title: 'Unique plugin ids',
    summary: '1 plugin ids are provided by more than one package',
    evidence: [{ path: 'turn-cost/package.json', detail: 'also declared by the backup' }],
    fix: { type: 'manual', summary: 'rename the duplicate', steps: ['keep one', 'rename the other'] },
  }
  const prompt = buildSquashPrompt(nightmare, { cwd: 'C:\\ws' })
  assert.match(prompt, /Workspace: C:\\ws/)
  assert.match(prompt, /check: plugin\.duplicate-id/)
  assert.match(prompt, /turn-cost\/package\.json — also declared by the backup/)
  assert.match(prompt, /Suggested repair \(manual\)/)
  assert.match(prompt, /rename the duplicate/)
  assert.match(prompt, /--check plugin\.duplicate-id/)
  assert.match(prompt, /Do not weaken, skip, rename, or delete the check/)
})

test('the squash prompt omits empty sections', () => {
  const prompt = buildSquashPrompt({ checkId: 'a.b', summary: 's', evidence: [], fix: null }, {})
  assert.doesNotMatch(prompt, /Evidence/)
  assert.doesNotMatch(prompt, /Suggested repair/)
  assert.match(prompt, /Workspace: \./)
})

test('ignore and remove refuse to run without a comment saying why', async () => {
  const { board: store } = board()
  await store.ingest({ findings: [finding()] })
  const [created] = await store.list()
  for (const action of ['ignore', 'remove']) {
    await assert.rejects(
      store.decide({ id: created.id, action }),
      (error) => error instanceof NightmareError && /needs a comment/.test(error.message),
    )
  }
  const ignored = await store.decide({ id: created.id, action: 'ignore', comment: 'the backup package is intentional' })
  assert.equal(ignored.status, 'ignored')
  assert.equal(ignored.decision.comment, 'the backup package is intentional')
  assert.match(ignored.history.at(-1).comment, /intentional/)
})

test('an ignored nightmare stays ignored across rescans', async () => {
  const { board: store } = board()
  await store.ingest({ findings: [finding()] })
  const [created] = await store.list()
  await store.decide({ id: created.id, action: 'ignore', comment: 'known and accepted' })
  await store.ingest({ findings: [finding()] })
  const [nightmare] = await store.list()
  assert.equal(nightmare.status, 'ignored', 'a rescan must not resurrect a decision the approver made')
  assert.equal(nightmare.occurrences, 2)
})

test('unknown ids and actions are rejected', async () => {
  const { board: store } = board()
  await assert.rejects(store.decide({ id: 'nrm_missing', action: 'accept' }), (error) => error.code === 'not-found')
  await store.ingest({ findings: [finding()] })
  const [created] = await store.list()
  await assert.rejects(store.decide({ id: created.id, action: 'shrug' }), (error) => error.code === 'invalid')
  await assert.rejects(store.decide({ id: created.id, action: 'accept', comment: 'x' }).then(() =>
    store.decide({ id: created.id, action: 'accept' })), (error) => error.code === 'invalid')
})

test('state reports counts in review order and survives a reopen of the store', async () => {
  const tables = { nightmares: {}, meta: {} }
  const makeCtx = () => ({
    get(name) {
      if (name !== 'storage') return undefined
      return { backend: { names: () => ['json'], get: () => ({ kv: { open: async () => unit(tables) } }) } }
    },
  })
  const first = createNightmareBoard(makeCtx(), {})
  await first.ingest({ findings: [finding(), finding({ id: 'workspace.large-file', severity: 'info', evidence: [{ path: 'big.bin' }] })] })
  const state = await first.state()
  assert.equal(state.counts.total, 2)
  assert.equal(state.counts.open, 2)
  assert.equal(state.nightmares[0].severity, 'error', 'error findings sort before info findings')

  const reopened = createNightmareBoard(makeCtx(), {})
  const after = await reopened.state()
  assert.equal(after.counts.total, 2, 'the board persists across instances')
  assert.deepEqual(after.actions, NIGHTMARE_ACTIONS)
})
