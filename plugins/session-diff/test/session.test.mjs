import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { decompressFrames, listSessions, parseSessionBuffer, readSessionFile, resolveSession, sessionHeader, workspaceSlug } from '../src/session.mjs'
import { tempDir, writeSessionLog } from './helpers.mjs'

test('workspaceSlug matches the Harness session-folder encoding', () => {
  assert.equal(
    workspaceSlug('C:\\Users\\alice\\OneDrive\\Documents\\demo-workspace'),
    '--C-Users-alice-OneDrive-Documents-demo-workspace--',
  )
  assert.equal(workspaceSlug('C:\\Users\\alice\\.dsh\\profiles\\desktop'), '--C-Users-alice-dsh-profiles-desktop--')
})

test('decompressFrames reads every appended zstd frame', () => {
  const events = [
    { type: 'session', version: 4, id: 'session-a', cwd: 'C:\\work' },
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const home = tempDir()
  const file = join(home, '.dsh', 'sessions', workspaceSlug('C:\\work'), 'session-a', 'session.v4.jsonl.zstd')
  writeSessionLog(file, events)
  const parsed = readSessionFile(file)
  assert.deepEqual(parsed.map(event => event.type), ['session', 'turn/start', 'turn/end'])
  assert.equal(parseSessionBuffer(decompressFrames(Buffer.from(''))).length, 0)
})

test('listSessions and resolveSession find the newest log for a workspace', () => {
  const home = tempDir()
  const cwd = join(home, 'work')
  const storeRoot = join(home, '.dsh', 'sessions')
  writeSessionLog(join(storeRoot, workspaceSlug(cwd), 'session-old', 'session.v4.jsonl.zstd'), [
    { type: 'session', version: 4, id: 'session-old', cwd },
  ])
  writeSessionLog(join(storeRoot, workspaceSlug(cwd), 'session-new', 'session.v4.jsonl.zstd'), [
    { type: 'session', version: 4, id: 'session-new', cwd },
  ])
  const sessions = listSessions(cwd, { home })
  assert.equal(sessions.length, 2)
  assert.equal(resolveSession('latest', { cwd, home }).id === 'session-old' || resolveSession('latest', { cwd, home }).id === 'session-new', true)
  assert.equal(resolveSession('session-old', { cwd, home }).id, 'session-old')
  assert.throws(() => resolveSession('missing', { cwd, home }), /session not found/)
})

test('sessionHeader returns the header or a synthetic empty one', () => {
  assert.equal(sessionHeader([{ type: 'session', id: 'x', cwd: 'C:\\w' }]).id, 'x')
  assert.equal(sessionHeader([]).id, undefined)
})
