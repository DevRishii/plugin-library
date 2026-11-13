import test from 'node:test'
import assert from 'node:assert/strict'
import { compareReceipts } from '../src/diff.mjs'

/**
 * Build a receipt fixture for comparison tests.
 * @param {object} [overrides] - top-level and nested overrides.
 * @returns {object} fixture receipt.
 */
function makeReceipt(overrides = {}) {
  const base = {
    version: 1,
    kind: 'session-receipt',
    generator: { name: 'session-diff', version: '1.0.0' },
    generatedAt: 1000,
    session: {
      id: 'session-1',
      title: 'Comparison fixture',
      cwd: 'C:/work/project',
      createdAt: 900,
      startedAt: 1000,
      endedAt: 2000,
      durationMs: 1000,
      eventCount: 20,
      firstSeq: 1,
      lastSeq: 20,
      agentPreset: 'default',
    },
    summary: {
      turns: 2,
      steps: 4,
      toolCalls: 3,
      filesAdded: 1,
      filesModified: 1,
      filesDeleted: 0,
      commands: 3,
      commandsFailed: 1,
      models: 2,
      totalCostUsd: 0.3,
      unpricedModels: [],
      openThreads: 3,
    },
    files: [
      { path: 'src/keep.mjs', status: 'modified', afterSha256: 'same' },
      { path: 'src/removed.mjs', status: 'added', afterSha256: 'removed' },
      { path: 'src/changed.mjs', status: 'modified', afterSha256: 'old' },
    ],
    commands: [
      { seq: 1, exitCode: 0, ok: true },
      { seq: 2, exitCode: 1, ok: false },
      { seq: 3, exitCode: 0, ok: true },
    ],
    models: [
      { provider: 'deepseek-account', model: 'deepseek-flash', costUsd: 0.1 },
      { provider: 'deepseek-account', model: 'deepseek-v4-pro', costUsd: 0.2 },
    ],
    turns: [],
    modelSwitches: [],
    plugins: [],
    settings: [],
    threads: [
      { kind: 'failing-command', title: 'Last command still failing', detail: 'pnpm test exited 1', ref: 2 },
      { kind: 'todo', title: 'Checklist item open', detail: 'Write docs', ref: 5 },
      { kind: 'failed-tests', title: 'Test run failed', detail: 'render suite failed', ref: 6 },
    ],
    snapshots: null,
  }
  return {
    ...base,
    ...overrides,
    session: { ...base.session, ...overrides.session },
    summary: { ...base.summary, ...overrides.summary },
  }
}

test('compareReceipts reports file, command, cost, model, and thread changes', () => {
  const left = makeReceipt()
  const right = makeReceipt({
    generatedAt: 2000,
    summary: { commands: 4, commandsFailed: 2, totalCostUsd: 0.7, models: 2 },
    files: [
      { path: 'src/keep.mjs', status: 'modified', afterSha256: 'same' },
      { path: 'src/changed.mjs', status: 'modified', afterSha256: 'new' },
      { path: 'src/added.mjs', status: 'added', afterSha256: 'added' },
    ],
    commands: [
      { seq: 1, exitCode: 0, ok: true },
      { seq: 2, exitCode: 1, ok: false },
      { seq: 3, exitCode: 0, ok: true },
      { seq: 4, exitCode: 1, ok: false },
    ],
    models: [
      { provider: 'deepseek-account', model: 'deepseek-flash', costUsd: 0.3 },
      { provider: 'deepseek-account', model: 'deepseek-v4-pro', costUsd: 0.2 },
      { provider: 'deepseek-account', model: 'deepseek-v4-new', costUsd: 0.2 },
    ],
    threads: [
      { kind: 'failing-command', title: 'Last command still failing', detail: 'pnpm test exited 1', ref: 2 },
      { kind: 'todo', title: 'Checklist item open', detail: 'Ship docs', ref: 7 },
      { kind: 'unfinished-turn', title: 'Turn 2 stopped', detail: 'Turn 2 stopped', ref: 8 },
    ],
  })

  const diff = compareReceipts(left, right)
  assert.equal(diff.identical, false)
  assert.deepEqual(diff.from, { sessionId: 'session-1', generatedAt: 1000 })
  assert.deepEqual(diff.to, { sessionId: 'session-1', generatedAt: 2000 })
  assert.deepEqual(diff.session, { sameSession: true, sameCwd: true })

  assert.deepEqual(diff.files.added, ['src/added.mjs'])
  assert.deepEqual(diff.files.removed, ['src/removed.mjs'])
  assert.deepEqual(diff.files.changed, [{
    path: 'src/changed.mjs',
    fromStatus: 'modified',
    toStatus: 'modified',
    fromAfterSha256: 'old',
    toAfterSha256: 'new',
  }])

  assert.deepEqual(diff.commands, {
    before: 3,
    after: 4,
    delta: 1,
    beforeFailed: 1,
    afterFailed: 2,
    deltaFailed: 1,
  })

  assert.equal(diff.cost.before, 0.3)
  assert.equal(diff.cost.after, 0.7)
  assert.equal(diff.cost.delta, 0.4)
  assert.deepEqual(diff.cost.byModel, [
    { model: 'deepseek-flash', before: 0.1, after: 0.3, delta: 0.2 },
    { model: 'deepseek-v4-pro', before: 0.2, after: 0.2, delta: 0 },
    { model: 'deepseek-v4-new', before: null, after: 0.2, delta: 0.2 },
  ])

  assert.deepEqual(diff.models, {
    added: ['deepseek-v4-new'],
    removed: [],
  })
  assert.deepEqual(diff.threads.resolved, [
    { kind: 'todo', detail: 'Write docs' },
    { kind: 'failed-tests', detail: 'render suite failed' },
  ])
  assert.deepEqual(diff.threads.opened, [
    { kind: 'todo', detail: 'Ship docs' },
    { kind: 'unfinished-turn', detail: 'Turn 2 stopped' },
  ])
  assert.deepEqual(diff.threads.persisted, [
    { kind: 'failing-command', detail: 'pnpm test exited 1' },
  ])
})

test('identical ignores generatedAt but detects content changes', () => {
  const left = makeReceipt()
  const sameContent = makeReceipt({ generatedAt: 999999 })
  const identical = compareReceipts(left, sameContent)
  assert.equal(compareReceipts(left, left).identical, true)
  assert.equal(identical.identical, true)
  assert.equal(identical.cost.delta, 0)
  assert.deepEqual(identical.files.changed, [])
  assert.deepEqual(identical.threads.resolved, [])

  const changed = makeReceipt({ summary: { totalCostUsd: 0.31 } })
  assert.equal(compareReceipts(left, changed).identical, false)
})

test('null costs stay null in before/after but count as zero in deltas', () => {
  const left = makeReceipt({
    summary: { totalCostUsd: null },
    models: [{ provider: 'deepseek-account', model: 'unpriced-model', costUsd: null }],
  })
  const right = makeReceipt({
    summary: { totalCostUsd: 0.5 },
    models: [{ provider: 'deepseek-account', model: 'unpriced-model', costUsd: 0.25 }],
  })
  const diff = compareReceipts(left, right)
  assert.equal(diff.cost.before, null)
  assert.equal(diff.cost.after, 0.5)
  assert.equal(diff.cost.delta, 0.5)
  assert.deepEqual(diff.cost.byModel, [
    { model: 'unpriced-model', before: null, after: 0.25, delta: 0.25 },
  ])
  assert.deepEqual(diff.models, { added: [], removed: [] })
})
