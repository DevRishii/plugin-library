import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../src/cli.mjs'
import { SnapshotStore, sessionReceiptDir } from '../src/snapshots.mjs'
import { sessionFile as sessionFileOf } from './cli-support.mjs'
import { sha256 } from '../src/paths.mjs'
import { sequencer, tempDir, writeSessionLog } from './helpers.mjs'

/**
 * A one-turn session that edits one file.
 * @param {{cwd: string, id: string, time?: number}} options - coordinates.
 * @returns {Array<object>} events.
 */
function editSession({ cwd, id, time = Date.UTC(2026, 10, 8, 12) }) {
  const seq = sequencer(0)
  const callId = `call-${seq()}`
  return [
    { type: 'session', version: 4, id, createdAt: time, cwd },
    { type: 'session/title', seq: seq(), time, data: { title: `Session ${id}`, source: { kind: 'fallback' } } },
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

/**
 * Create a workspace, a session log, and the pre-write snapshot for `note.txt`.
 * @returns {Promise<{home: string, cwd: string, id: string}>} fixture coordinates.
 */
async function fixture() {
  const home = tempDir()
  const cwd = tempDir()
  const id = 'session-cli'
  writeSessionLog(sessionFileOf(home, cwd, id), editSession({ cwd, id }))
  writeFileSync(join(cwd, 'note.txt'), 'one\ntwo\n')
  const store = new SnapshotStore({ dir: sessionReceiptDir(cwd, id, { home }) })
  await store.capture({ absolute: join(cwd, 'note.txt'), path: 'note.txt', turn: 1 })
  writeFileSync(join(cwd, 'note.txt'), 'one\nthree\n')
  return { home, cwd, id }
}

/**
 * Collect stdout/stderr from one run.
 * @param {string[]} argv - CLI arguments.
 * @param {{home: string, cwd: string}} options - fixture coordinates.
 * @returns {Promise<{code: number, out: string, err: string}>} the invocation result.
 */
async function invoke(argv, options) {
  let out = ''
  let err = ''
  const code = await run(argv, { stdout: text => { out += text }, stderr: text => { err += text }, cwd: options.cwd, home: options.home })
  return { code, out, err }
}

test('print emits the stored receipt when one exists, and --rebuild re-derives it', async () => {
  const { home, cwd, id } = await fixture()
  const dir = sessionReceiptDir(cwd, id, { home })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ version: 1, kind: 'session-receipt', session: { id: 'stored-id' }, files: [], commands: [], models: [], turns: [], plugins: [], settings: [], threads: [], summary: { totalCostUsd: 0 } }))
  const stored = await invoke(['print', 'latest', '--json'], { home, cwd })
  assert.equal(stored.code, 0)
  assert.equal(JSON.parse(stored.out).session.id, 'stored-id')
  const rebuilt = await invoke(['print', 'latest', '--json', '--rebuild'], { home, cwd })
  assert.equal(rebuilt.code, 0)
  const receipt = JSON.parse(rebuilt.out)
  assert.equal(receipt.session.id, id)
  assert.equal(receipt.files[0].beforeSource, 'snapshot')
  assert.equal(receipt.files[0].beforeSha256, sha256('one\ntwo\n'))
})

test('export writes markdown, json, and html', async () => {
  const { home, cwd } = await fixture()
  const target = tempDir()
  for (const format of ['markdown', 'json', 'html']) {
    const file = join(target, `receipt.${format}`)
    const result = await invoke(['export', 'latest', '--rebuild', '--format', format, '--out', file], { home, cwd })
    assert.equal(result.code, 0, result.err)
    const body = readFileSync(file, 'utf8')
    if (format === 'json') assert.equal(JSON.parse(body).kind, 'session-receipt')
    else if (format === 'html') assert.match(body, /^<!doctype html>/i)
    else assert.match(body, /^# Session receipt:/)
  }
})

test('list reports sessions with and without receipts', async () => {
  const { home, cwd, id } = await fixture()
  const missing = await invoke(['list', '--json'], { home, cwd })
  assert.equal(missing.code, 0)
  const before = JSON.parse(missing.out)
  assert.equal(before.sessions[0].id, id)
  assert.equal(before.sessions[0].receipt, null)
  const rebuild = await invoke(['print', 'latest', '--json', '--rebuild'], { home, cwd })
  assert.equal(rebuild.code, 0)
})

test('compare reports file and cost deltas between two sessions', async () => {
  const home = tempDir()
  const cwd = tempDir()
  writeSessionLog(sessionFileOf(home, cwd, 'session-a'), editSession({ cwd, id: 'session-a' }))
  writeSessionLog(sessionFileOf(home, cwd, 'session-b'), editSession({ cwd, id: 'session-b' }))
  writeFileSync(join(cwd, 'note.txt'), 'one\nthree\n')
  const result = await invoke(['compare', 'session-a', 'session-b', '--rebuild', '--json'], { home, cwd })
  assert.equal(result.code, 0, result.err)
  const comparison = JSON.parse(result.out)
  assert.equal(comparison.identical, false)
  assert.equal(comparison.files.added.length, 0)
  assert.equal(comparison.files.changed.length, 0)
  assert.equal(comparison.cost.before, 0.15)
  assert.equal(comparison.cost.after, 0.15)
})

test('restore refuses drift from a stored receipt, and --force restores the snapshot', async () => {
  const { home, cwd, id } = await fixture()
  const dir = sessionReceiptDir(cwd, id, { home })
  const first = await invoke(['print', 'latest', '--json', '--rebuild'], { home, cwd })
  assert.equal(first.code, 0)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'receipt.json'), first.out)
  writeFileSync(join(cwd, 'note.txt'), 'manual edit\n')
  const refused = await invoke(['restore', id, 'note.txt'], { home, cwd })
  assert.equal(refused.code, 1)
  assert.match(refused.err, /refusing to overwrite/)
  const forced = await invoke(['restore', id, 'note.txt', '--force'], { home, cwd })
  assert.equal(forced.code, 0, forced.err)
  assert.equal(readFileSync(join(cwd, 'note.txt'), 'utf8'), 'one\ntwo\n')
})

test('restore rejects a path that is not in the receipt', async () => {
  const { home, cwd, id } = await fixture()
  const result = await invoke(['restore', id, 'other.txt'], { home, cwd })
  assert.equal(result.code, 1)
  assert.match(result.err, /not a file in the receipt/)
})

test('gc collects expired snapshots for the working directory', async () => {
  const { home, cwd } = await fixture()
  const result = await invoke(['gc', '--days', '1'], { home, cwd })
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /Nothing to collect|removed/)
  assert.equal(existsSync(join(cwd, 'note.txt')), true)
})
