/**
 * Activity digest inside the Dreamer context: receipts become a bounded,
 * deterministic summary with a recurrence rollup. The engine is the sibling
 * Session Diff project, so these tests also prove the cross-plugin read path.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { activityDigest } from '../activity.js'
import { sessionReceiptDir } from '../../session-diff/src/snapshots.mjs'
import { buildSessionFixture, tempDir, writeSessionLog } from '../../session-diff/test/helpers.mjs'

/**
 * Write one session log for a workspace.
 * @param {string} home - fake home.
 * @param {string} cwd - session working directory.
 * @param {string} id - session id.
 * @param {Array<object>} events - events in order.
 */
function writeLog(home, cwd, id, events) {
  writeSessionLog(join(home, '.dsh', 'sessions', workspaceSlugOf(cwd), id, 'session.v4.jsonl.zstd'), events)
}

/**
 * Local slug copy so the test does not depend on the engine for path setup.
 * @param {string} cwd - working directory.
 * @returns {string} the folder name.
 */
function workspaceSlugOf(cwd) {
  return `--${cwd.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}--`
}

/**
 * Store a minimal receipt for one session.
 * @param {string} home - fake home.
 * @param {string} cwd - session working directory.
 * @param {string} id - session id.
 * @param {object} overrides - receipt fields.
 */
function writeReceipt(home, cwd, id, overrides = {}) {
  const dir = sessionReceiptDir(cwd, id, { home })
  mkdirSync(dir, { recursive: true })
  const receipt = {
    version: 1,
    kind: 'session-receipt',
    generatedAt: 10,
    session: { id, cwd, startedAt: 1_000, endedAt: 2_000, durationMs: 1_000, title: 'Stored session' },
    summary: {
      filesAdded: 1, filesModified: 0, filesDeleted: 0, commands: 2, commandsFailed: 1,
      openThreads: 1, models: 1, totalCostUsd: 0.25,
    },
    files: [{ path: 'src/app.js', status: 'added', beforeSha256: null, afterSha256: 'a'.repeat(64) }],
    commands: [
      { seq: 4, command: 'npm test', exitCode: 1, firstFailureLine: 'AssertionError: 1 !== 2', failedTests: true },
      { seq: 5, command: 'git status', exitCode: 0, firstFailureLine: null, failedTests: false },
    ],
    threads: [{ kind: 'failed-tests', detail: 'AssertionError: 1 !== 2', ref: 4 }],
    models: [{ provider: 'deepseek-account', model: 'deepseek-flash', requests: 1, costUsd: 0.25 }],
    ...overrides,
  }
  writeFileSync(join(dir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
}

test('stored receipts summarize into a bounded session row and rollup', async () => {
  const home = tempDir('dream-activity-')
  const cwd = tempDir('dream-workspace-')
  writeReceipt(home, cwd, 'session-stored')
  const digest = await activityDigest([{ id: 'session-stored', title: 'Stored session', cwd }], { home, projectCwd: cwd, now: 5 })
  assert.equal(digest.generatedAt, 5)
  assert.equal(digest.sessions.length, 1)
  const row = digest.sessions[0]
  assert.equal(row.available, true)
  assert.equal(row.source, 'stored')
  assert.equal(row.files.added, 1)
  assert.equal(row.commands.failed, 1)
  assert.equal(row.costUsd, 0.25)
  assert.deepEqual(row.models, ['deepseek-flash'])
  assert.deepEqual(row.topFiles, [{ path: 'src/app.js', status: 'added' }])
  assert.equal(row.failingCommands[0].firstFailureLine, 'AssertionError: 1 !== 2')
  assert.equal(row.topThreads[0].kind, 'failed-tests')
  assert.equal(row.topThreads[0].detail, 'AssertionError: 1 !== 2')
  assert.equal(digest.rollup.sessions, 1)
  assert.equal(digest.rollup.commands.failed, 1)
  assert.equal(digest.rollup.costUsd, 0.25)
})

test('a session without a stored receipt is built from its log', async () => {
  const home = tempDir('dream-activity-')
  const cwd = tempDir('dream-workspace-')
  const file = join(cwd, 'note.txt')
  writeLog(home, cwd, 'session-built', buildSessionFixture({ cwd, filePath: file, oldText: 'two', newText: 'three' }))
  writeFileSync(file, 'one\nthree\n')
  const digest = await activityDigest([{ id: 'session-built', title: 'Built session', cwd }], { home, projectCwd: cwd, now: 6 })
  const row = digest.sessions[0]
  assert.equal(row.available, true)
  assert.equal(row.source, 'built')
  assert.equal(row.files.added, 1)
  assert.equal(row.commands.total, 2)
  assert.equal(row.commands.failed, 1)
  assert.equal(row.costUsd, 0.15)
  assert.equal(row.topFiles[0].path, 'note.txt')
  assert.ok(row.openThreads >= 2)
  assert.equal(row.failingCommands[0].command, 'node --test test/broken.test.mjs')
})

test('recurring files, failures, and threads are rolled up across sessions', async () => {
  const home = tempDir('dream-activity-')
  const cwd = tempDir('dream-workspace-')
  writeLog(home, cwd, 'session-one', buildSessionFixture({ cwd, filePath: join(cwd, 'note.txt'), oldText: 'two', newText: 'three' }))
  writeLog(home, cwd, 'session-two', buildSessionFixture({ cwd, filePath: join(cwd, 'note.txt'), oldText: 'two', newText: 'three' }))
  writeFileSync(join(cwd, 'note.txt'), 'one\nthree\n')
  const digest = await activityDigest([
    { id: 'session-one', title: 'One', cwd },
    { id: 'session-two', title: 'Two', cwd },
  ], { home, projectCwd: cwd })
  assert.equal(digest.rollup.sessions, 2)
  assert.equal(digest.rollup.commands.total, 4)
  assert.equal(digest.rollup.commands.failed, 2)
  assert.equal(digest.rollup.recurringFiles[0].path, 'note.txt')
  assert.equal(digest.rollup.recurringFiles[0].sessions, 2)
  assert.equal(digest.rollup.recurringFailures[0].command, 'node --test test/broken.test.mjs')
  assert.equal(digest.rollup.recurringFailures[0].sessions, 2)
  assert.ok(digest.rollup.openThreadRepeats.length >= 1)
})

test('an unavailable session never throws and is counted separately', async () => {
  const home = tempDir('dream-activity-')
  const cwd = tempDir('dream-workspace-')
  const digest = await activityDigest([{ id: 'session-missing', title: 'Missing', cwd }], { home, projectCwd: cwd })
  assert.equal(digest.sessions[0].available, false)
  assert.equal(digest.rollup.sessions, 0)
  assert.equal(digest.rollup.unavailable, 1)
})

test('excludeId keeps the current Dreamer session out of its own digest', async () => {
  const home = tempDir('dream-activity-')
  const cwd = tempDir('dream-workspace-')
  writeReceipt(home, cwd, 'session-current')
  writeReceipt(home, cwd, 'session-other')
  const digest = await activityDigest([
    { id: 'session-current', cwd },
    { id: 'session-other', cwd },
  ], { home, projectCwd: cwd, excludeId: 'session-current' })
  assert.deepEqual(digest.sessions.map(row => row.id), ['session-other'])
})
