import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildReceipt, deriveBefore, replayOps } from '../src/receipt.mjs'
import { SnapshotStore, sessionReceiptDir } from '../src/snapshots.mjs'
import { sha256 } from '../src/paths.mjs'
import { buildSessionFixture, sequencer, tempDir } from './helpers.mjs'

/**
 * A one-turn edit session.
 * @param {{cwd: string, time?: number}} options - fixture coordinates.
 * @returns {Array<object>} events.
 */
function editSession({ cwd, time = Date.UTC(2026, 10, 8, 12) }) {
  const seq = sequencer(0)
  const callId = `call-${seq()}`
  return [
    { type: 'session', version: 4, id: 'session-edit', createdAt: time, cwd },
    { type: 'turn/start', seq: seq(), time, data: { turn: 1 } },
    { type: 'step/start', seq: seq(), time, data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: seq(), time, data: { turn: 1, step: 1, callId, name: 'edit', arguments: JSON.stringify({ file_path: 'note.txt', old_string: 'two', new_string: 'three' }) } },
    {
      type: 'tool/result', seq: seq(), time,
      data: {
        turn: 1, step: 1,
        message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: 'updated' }], isError: false },
        meta: { path: 'note.txt', diffs: [{ path: 'note.txt', oldText: 'two', newText: 'three' }] },
      },
    },
    {
      type: 'assistant/message', seq: seq(), time,
      data: {
        turn: 1, step: 1,
        usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
        message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } },
      },
    },
    { type: 'turn/end', seq: seq(), time, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

test('replayOps and deriveBefore reverse an edit chain exactly', () => {
  const ops = [
    { operation: 'edit', oldString: 'two', newString: 'three', replaceAll: false },
    { operation: 'edit', oldString: 'one', newString: 'ONE', replaceAll: false },
  ]
  assert.equal(replayOps(ops, 'one\ntwo\n'), 'ONE\nthree\n')
  assert.equal(deriveBefore(ops, 'ONE\nthree\n').sha256, sha256('one\ntwo\n'))
  assert.equal(deriveBefore([{ operation: 'create', content: 'x' }], 'x'), null)
  assert.equal(deriveBefore([{ operation: 'edit', oldString: 'absent', newString: 'x' }], 'y'), null)
  assert.equal(deriveBefore([{ operation: 'update', content: 'x' }], 'x'), null)
  assert.equal(deriveBefore([
    { operation: 'update', content: 'one\nthree\n' },
    { operation: 'edit', oldString: 'three', newString: 'four' },
  ], 'one\nfour\n'), null)
})

test('buildReceipt marks an edited file with a snapshot before-hash and a disk after-hash', async () => {
  const home = tempDir()
  const cwd = tempDir()
  const absolute = join(cwd, 'note.txt')
  writeFileSync(absolute, 'one\ntwo\n')
  const store = new SnapshotStore({ dir: sessionReceiptDir(cwd, 'session-edit', { home }) })
  const capture = await store.capture({ absolute, path: 'note.txt', turn: 1 })
  assert.equal(capture.hash, sha256('one\ntwo\n'))
  writeFileSync(absolute, 'one\nthree\n')

  const receipt = await buildReceipt({ events: editSession({ cwd }), cwd, store, home, generatedAt: 1 })
  const row = receipt.files[0]
  assert.equal(row.path, 'note.txt')
  assert.equal(row.status, 'modified')
  assert.equal(row.beforeSource, 'snapshot')
  assert.equal(row.beforeSha256, sha256('one\ntwo\n'))
  assert.equal(row.afterSha256, sha256('one\nthree\n'))
  assert.equal(receipt.summary.filesModified, 1)
  assert.equal(receipt.summary.totalCostUsd, 0.15)
  assert.equal(receipt.snapshots.entries, 1)
})

test('buildReceipt derives the before-hash without a snapshot and refuses to guess', async () => {
  const home = tempDir()
  const cwd = tempDir()
  const absolute = join(cwd, 'note.txt')
  writeFileSync(absolute, 'one\nthree\n')
  const receipt = await buildReceipt({ events: editSession({ cwd }), cwd, store: null, home })
  assert.equal(receipt.files[0].beforeSource, 'derived')
  assert.equal(receipt.files[0].beforeSha256, sha256('one\ntwo\n'))

  writeFileSync(absolute, 'formatted\n')
  const drifted = await buildReceipt({ events: editSession({ cwd }), cwd, store: null, home })
  assert.equal(drifted.files[0].beforeSource, 'unavailable')
  assert.equal(drifted.files[0].beforeSha256, null)
})

test('buildReceipt lists deleted files with no after-hash', async () => {
  const home = tempDir()
  const cwd = tempDir()
  const absolute = join(cwd, 'note.txt')
  writeFileSync(absolute, 'one\ntwo\n')
  const store = new SnapshotStore({ dir: sessionReceiptDir(cwd, 'session-edit', { home }) })
  await store.capture({ absolute, path: 'note.txt', turn: 1 })
  writeFileSync(absolute, 'one\nthree\n')
  rmSync(absolute)
  const receipt = await buildReceipt({ events: editSession({ cwd }), cwd, store, home })
  assert.equal(receipt.files[0].status, 'deleted')
  assert.equal(receipt.files[0].afterSha256, null)
  assert.equal(receipt.files[0].beforeSha256, sha256('one\ntwo\n'))
})

test('buildReceipt records added files, commands, failed tests, threads, and cost', async () => {
  const home = tempDir()
  const cwd = tempDir()
  const events = buildSessionFixture({ cwd, filePath: join(cwd, 'note.txt'), oldText: 'two', newText: 'three' })
  events.push({ type: 'tool/call', seq: 80, time: 1, data: { turn: 1, step: 1, callId: 'call-plugin', name: 'plugin_manager', arguments: JSON.stringify({ action: 'set_plugin', target: '@local/turn-cost', enabled: false }) } })
  events.push({ type: 'command/run', seq: 81, time: 1, data: { commandId: 'cmd-1', name: 'permission', args: ' danger-full-access', source: { kind: 'user' } } })
  writeFileSync(join(cwd, 'note.txt'), 'one\nthree\n')
  const receipt = await buildReceipt({ events, cwd, store: null, home })

  const row = receipt.files[0]
  assert.equal(row.status, 'added')
  assert.equal(row.beforeSource, 'absent')
  assert.equal(row.beforeSha256, null)
  assert.equal(row.afterSha256, sha256('one\nthree\n'))
  assert.equal(receipt.summary.filesAdded, 1)
  assert.equal(receipt.summary.commands, 2)
  assert.equal(receipt.summary.commandsFailed, 1)
  assert.equal(receipt.summary.totalCostUsd, 0.15)
  assert.equal(receipt.summary.openThreads, receipt.threads.length)
  assert.equal(receipt.commands[0].firstFailureLine, 'AssertionError: 1 !== 2')
  assert.equal(receipt.commands[0].failedTests, true)
  const kinds = receipt.threads.map(thread => thread.kind)
  assert.ok(kinds.includes('failing-command'))
  assert.ok(kinds.includes('failed-tests'))
  assert.ok(kinds.includes('todo'))
  assert.equal(receipt.threads.find(thread => thread.kind === 'failing-command').command, 'node --test test/broken.test.mjs')
  assert.equal(receipt.plugins.length, 1)
  assert.equal(receipt.plugins[0].target, '@local/turn-cost')
  assert.equal(receipt.settings.length, 1)
  assert.equal(receipt.models[0].model, 'deepseek-flash')
  assert.equal(receipt.turns[0].costUsd, 0.15)
})

test('buildReceipt excludes node_modules and .git unless asked otherwise', async () => {
  const home = tempDir()
  const cwd = tempDir()
  mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(cwd, 'node_modules', 'pkg', 'index.js'), 'x')
  const events = buildSessionFixture({ cwd, filePath: join(cwd, 'note.txt'), oldText: 'two', newText: 'three' })
  events.push({
    type: 'tool/call', seq: 95, time: 1,
    data: { turn: 1, step: 1, callId: 'call-dep', name: 'write', arguments: JSON.stringify({ file_path: join(cwd, 'node_modules', 'pkg', 'index.js'), content: 'x' }) },
  })
  writeFileSync(join(cwd, 'note.txt'), 'one\nthree\n')
  const excluded = await buildReceipt({ events, cwd, store: null, home })
  assert.equal(excluded.files.length, 1)
  const included = await buildReceipt({ events, cwd, store: null, home, excludes: [] })
  assert.equal(included.files.length, 2)
  assert.ok(included.files.some(file => file.path.includes('node_modules')))
})
