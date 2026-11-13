import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandOutcome, extractFacts, parseArguments } from '../src/facts.mjs'
import { buildSessionFixture } from './helpers.mjs'

test('parseArguments tolerates malformed and empty input', () => {
  assert.deepEqual(parseArguments('{"a":1}'), { a: 1 })
  assert.deepEqual(parseArguments('not json'), {})
  assert.deepEqual(parseArguments(''), {})
  assert.deepEqual(parseArguments(undefined), {})
})

test('commandOutcome reads the exit marker and the first failing line', () => {
  assert.deepEqual(commandOutcome('all good', false), { exitCode: 0, firstFailureLine: null })
  assert.deepEqual(
    commandOutcome('v24.18.0\r\n[stderr]\nCannot find path X\r\n[exit code: 1]', false),
    { exitCode: 1, firstFailureLine: 'Cannot find path X' },
  )
  assert.deepEqual(
    commandOutcome('line one\n[exit code: 2]', false),
    { exitCode: 2, firstFailureLine: 'line one' },
  )
  assert.deepEqual(commandOutcome('boom', true), { exitCode: 1, firstFailureLine: 'boom' })
  assert.deepEqual(
    commandOutcome('[stderr]\nParserError: \nLine |\n  23 |    if ($c -eq 0) "$p : not found"\n     |                ~\n     | Missing statement block after if ( condition ).\n[exit code: 1]', false),
    { exitCode: 1, firstFailureLine: 'Missing statement block after if ( condition ).' },
  )
  assert.deepEqual(
    commandOutcome('FullName\n----\nfoo.txt\n[exit code: 1]', false),
    { exitCode: 1, firstFailureLine: 'foo.txt' },
  )
})

test('extractFacts joins file ops, commands, usage, todos, and TODO markers', () => {  const cwd = 'C:\\work'
  const fixture = buildSessionFixture({ cwd, filePath: 'note.txt', oldText: 'two', newText: 'three' })
  fixture.push({
    type: 'tool/call', seq: 90, time: 1, data: { turn: 1, step: 1, callId: 'call-marker', name: 'write', arguments: JSON.stringify({ file_path: 'marker.js', content: '// TODO: tidy this\nconst x = 1\n' }) },
  })
  fixture.push({
    type: 'tool/result', seq: 91, time: 1,
    data: {
      turn: 1, step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId: 'call-marker' }, toolCallId: 'call-marker', content: [{ type: 'text', text: 'created' }], isError: false },
      meta: { path: 'marker.js', operation: 'create', diffs: [] },
    },
  })
  const facts = extractFacts(fixture, { cwd })
  assert.equal(facts.files.length, 2)
  const note = facts.files.find(file => file.path === 'note.txt')
  assert.equal(note.ops.length, 2)
  assert.equal(note.ops[0].operation, 'create')
  assert.equal(note.ops[1].operation, 'edit')
  assert.equal(facts.commands.length, 2)
  assert.equal(facts.commands[0].exitCode, 1)
  assert.equal(facts.commands[0].failedTests, true)
  assert.equal(facts.commands[0].firstFailureLine, 'AssertionError: 1 !== 2')
  assert.equal(facts.commands[1].exitCode, 0)
  assert.equal(facts.models.length, 1)
  assert.equal(facts.models[0].model, 'deepseek-flash')
  assert.equal(facts.models[0].usage.inputTokens, 1_000_000)
  assert.deepEqual(facts.switches.map(route => route.model), ['deepseek-flash'])
  assert.equal(facts.todoWrites.length, 1)
  assert.equal(facts.todoWrites[0].todos.filter(todo => todo.status === 'pending').length, 1)
  assert.equal(facts.todoMarkers.length, 1)
  assert.equal(facts.todoMarkers[0].kind, 'TODO')
  assert.equal(facts.todoMarkers[0].path, 'marker.js')
  assert.equal(facts.plugins.length, 0)
  assert.equal(facts.steps, 1)
  assert.equal(facts.toolCalls, 5)
})

test('a failed test summary prefers the real failure line over passing prose', () => {
  const cwd = 'C:\\work'
  const events = [
    { type: 'session', version: 4, id: 'session-summary', cwd },
    { type: 'tool/call', seq: 1, time: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) } },
    {
      type: 'tool/result', seq: 2, time: 2,
      data: {
        turn: 1, step: 1,
        message: {
          role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1',
          content: [{ type: 'text', text: '✔ a failed launch is handled\nAssertionError: 1 !== 2\n[exit code: 1]' }],
          isError: false,
        },
      },
    },
  ]
  const facts = extractFacts(events, { cwd })
  assert.equal(facts.commands[0].failedTests, true)
  assert.equal(facts.commands[0].failureSummary, 'AssertionError: 1 !== 2')
})
