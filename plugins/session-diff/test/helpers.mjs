/** Shared fixtures for the session-diff test suites. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

/**
 * Create a temporary workspace directory.
 * @param {string} [prefix] - directory prefix.
 * @returns {string} the absolute directory.
 */
export function tempDir(prefix = 'session-diff-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * Write one event log as a multi-frame zstd file, matching the Harness append pattern.
 * @param {string} file - target `session.v4.jsonl.zstd` path.
 * @param {Array<object>} events - events in order.
 */
export function writeSessionLog(file, events) {
  mkdirSync(dirname(file), { recursive: true })
  const frames = events.map(event => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')))
  writeFileSync(file, Buffer.concat(frames))
}

/**
 * Unique event sequence helper.
 * @param {number} [start] - first sequence number.
 * @returns {() => number} sequence allocator.
 */
export function sequencer(start = 0) {
  let next = start
  return () => {
    const value = next
    next += 1
    return value
  }
}

/**
 * Build a two-turn session: a write (create), an edit with a snapshot, a
 * failing command and a passing command, a failed test run, a model switch,
 * and a pending TODO.
 * @param {{cwd: string, time?: number, id?: string, filePath: string, oldText: string, newText: string}} options - fixture coordinates.
 * @returns {Array<object>} events in order.
 */
export function buildSessionFixture(options) {
  const { cwd, id = 'session-fixture', time = Date.UTC(2026, 10, 8, 12), filePath } = options
  const seq = sequencer(0)
  const at = spread => time + spread
  const call = (name, args) => {
    const callId = `call-${seq()}`
    return {
      callId,
      event: {
        type: 'tool/call',
        seq: seq(),
        time: at(seq()),
        data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
      },
    }
  }
  const result = (callId, text, meta, isError = false) => ({
    type: 'tool/result',
    seq: seq(),
    time: at(seq()),
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text }], isError },
      ...meta === undefined ? {} : { meta },
    },
  })
  const events = [
    { type: 'session', version: 4, id, createdAt: at(0), cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' },
    { type: 'session/title', seq: seq(), time: at(0), data: { title: 'Fixture session', source: { kind: 'fallback' } } },
    { type: 'turn/start', seq: seq(), time: at(0), data: { turn: 1 } },
    { type: 'step/start', seq: seq(), time: at(0), data: { turn: 1, step: 1 } },
  ]
  const write = call('write', { file_path: filePath, content: 'one\ntwo\n' })
  events.push(write.event, result(write.callId, 'created', { path: filePath, operation: 'create', diffs: [] }))
  const edit = call('edit', { file_path: filePath, old_string: 'two', new_string: 'three' })
  events.push(edit.event, result(edit.callId, 'updated', { path: filePath, diffs: [{ path: filePath, oldText: 'two', newText: 'three' }] }))
  events.push({
    type: 'assistant/message',
    seq: seq(),
    time: at(1),
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } },
    },
  })
  events.push({ type: 'step/end', seq: seq(), time: at(1), data: { turn: 1, step: 1 } })
  const failing = call('bash', { command: 'node --test test/broken.test.mjs' })
  events.push(failing.event, result(failing.callId, 'not ok 1 - adds numbers\n[stderr]\nAssertionError: 1 !== 2\n[exit code: 1]'))
  const passing = call('bash', { command: 'git status --short' })
  events.push(passing.event, result(passing.callId, '[exit code: 0]'))
  events.push({
    type: 'todo/write',
    seq: seq(),
    time: at(2),
    data: { todos: [{ content: 'Fix the failing test', status: 'pending' }, { content: 'Write docs', status: 'completed' }] },
  })
  events.push({ type: 'workspace/changes', seq: seq(), time: at(3), data: { turn: 1 } })
  events.push({ type: 'turn/end', seq: seq(), time: at(3), data: { turn: 1, reason: { kind: 'completed' } } })
  return events
}

/**
 * Build a minimal one-turn session that only writes one file.
 * @param {{cwd: string, id: string, path: string, content: string, time?: number}} options - fixture coordinates.
 * @returns {Array<object>} events in order.
 */
export function buildSimpleSession(options) {
  const { cwd, id, path, content, time = Date.UTC(2026, 10, 8, 12) } = options
  const seq = sequencer(0)
  const callId = `call-${seq()}`
  return [
    { type: 'session', version: 4, id, createdAt: time, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' },
    { type: 'session/title', seq: seq(), time, data: { title: `Session ${id}`, source: { kind: 'fallback' } } },
    { type: 'turn/start', seq: seq(), time, data: { turn: 1 } },
    { type: 'step/start', seq: seq(), time, data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: seq(), time, data: { turn: 1, step: 1, callId, name: 'write', arguments: JSON.stringify({ file_path: path, content }) } },
    {
      type: 'tool/result',
      seq: seq(),
      time,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: 'created' }], isError: false },
        meta: { path, operation: 'create', diffs: [] },
      },
    },
    {
      type: 'assistant/message',
      seq: seq(),
      time,
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
        message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } },
      },
    },
    { type: 'turn/end', seq: seq(), time, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}
