import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../index.js'
import { sha256 } from '../src/paths.mjs'
import { sessionReceiptDir } from '../src/snapshots.mjs'
import { tempDir } from './helpers.mjs'

/**
 * A minimal Cordis host: records handlers, routes, tools, and commands.
 * @returns {object} the fake host.
 */
function fakeHost() {
  const handlers = new Map()
  const routes = new Map()
  const tools = []
  const commands = []
  const warnings = []
  const ctx = {
    fs: { processPath: target => target },
    logger: { warn: message => warnings.push(message) },
    on(name, listener) {
      const list = handlers.get(name) ?? []
      list.push(listener)
      handlers.set(name, list)
    },
    effect(fn) {
      const value = fn()
      return typeof value === 'function' ? value : () => {}
    },
    get(name) {
      if (name === 'webServer') return { register: (route) => { routes.set(route.path, route.handler); return () => {} } }
      if (name === 'tools') return { register: (definition) => { tools.push(definition); return () => {} } }
      if (name === 'commands') return { register: (definition) => { commands.push(definition); return () => {} } }
      return undefined
    },
  }
  return { ctx, handlers, routes, tools, commands, warnings }
}

/**
 * Run every listener registered for an event.
 * @param {Map<string, Function[]>} handlers - registered listeners.
 * @param {string} name - event name.
 * @param {...unknown} args - event arguments.
 * @returns {Promise<void>} settlement.
 */
async function emit(handlers, name, ...args) {
  for (const listener of handlers.get(name) ?? []) await listener(...args)
}

/**
 * Poll until a predicate holds.
 * @param {() => boolean} predicate - condition.
 * @param {number} [timeoutMs] - bound.
 * @returns {Promise<void>} settlement.
 */
async function until(predicate, timeoutMs = 2_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the plugin')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * A response object that captures status, headers, and body.
 * @returns {object} the fake response.
 */
function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(body) { this.body = body ?? '' },
  }
}

/**
 * A request object for a GET or a JSON POST.
 * @param {string} url - request URL.
 * @param {object} [body] - JSON body for POST.
 * @returns {object} the fake request.
 */
function fakeRequest(url, body) {
  const request = { url, method: body === undefined ? 'GET' : 'POST' }
  if (body !== undefined) {
    request[Symbol.asyncIterator] = async function* iterator() {
      yield Buffer.from(JSON.stringify(body), 'utf8')
    }
  }
  return request
}

test('the host plugin captures a pre-write snapshot, records a receipt, and serves it', async () => {
  const home = tempDir()
  const cwd = tempDir()
  const file = join(cwd, 'note.txt')
  writeFileSync(file, 'before\n')
  const host = fakeHost()
  apply(host.ctx, { home })

  const session = { id: 'session-plugin', header: { cwd } }
  const exec = { agent: { session } }
  await emit(host.handlers, 'session/event', session, { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })
  await emit(host.handlers, 'tools/pre-execute', exec, async () => ({ allowed: true }))
  await emit(host.handlers, 'fs/write-intent', file, exec, async () => ({ target: file }))
  writeFileSync(file, 'after\n')

  await emit(host.handlers, 'session/event', session, {
    type: 'tool/call', seq: 1, time: 2,
    data: { turn: 1, step: 1, callId: 'call-1', name: 'write', arguments: JSON.stringify({ file_path: file, content: 'after\n' }) },
  })
  await emit(host.handlers, 'session/event', session, {
    type: 'tool/result', seq: 2, time: 3,
    data: {
      turn: 1, step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [{ type: 'text', text: 'created' }], isError: false },
      meta: { path: file, operation: 'create', diffs: [] },
    },
  })
  await emit(host.handlers, 'session/event', session, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } })

  const dir = sessionReceiptDir(cwd, 'session-plugin', { home })
  await until(() => existsSync(join(dir, 'receipt.json')))
  const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'))
  assert.equal(receipt.session.id, 'session-plugin')
  assert.equal(receipt.files.length, 1)
  assert.equal(receipt.files[0].beforeSource, 'snapshot')
  assert.equal(receipt.files[0].beforeSha256, sha256('before\n'))
  assert.equal(receipt.files[0].afterSha256, sha256('after\n'))
  assert.equal(existsSync(join(dir, 'receipt.md')), true)

  const response = fakeResponse()
  await host.routes.get('/session-diff/receipt')(fakeRequest('/session-diff/receipt?session=session-plugin'), response)
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).receipt.session.id, 'session-plugin')

  const exportResponse = fakeResponse()
  await host.routes.get('/session-diff/export')(fakeRequest('/session-diff/export?session=session-plugin&format=html'), exportResponse)
  assert.equal(exportResponse.statusCode, 200)
  assert.match(exportResponse.body, /^<!doctype html>/i)

  assert.equal(host.tools.length, 1)
  assert.equal(host.commands.length, 1)
  const command = await host.commands[0].handler({ rawInput: '', agent: { session } })
  assert.equal(command.kind, 'success')
  assert.match(command.text, /Session session-plugin/)

  const toolText = await host.tools[0].execute({ action: 'print', session: 'session-plugin' }, { agent: { session } })
  assert.match(toolText, /Session session-plugin/)
  assert.equal(host.warnings.length, 0)
})

test('the restore route refuses drift, then restores with force', async () => {
  const home = tempDir()
  const cwd = tempDir()
  const file = join(cwd, 'note.txt')
  writeFileSync(file, 'before\n')
  const host = fakeHost()
  apply(host.ctx, { home })
  const session = { id: 'session-restore', header: { cwd } }
  const exec = { agent: { session } }
  await emit(host.handlers, 'session/event', session, { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })
  await emit(host.handlers, 'tools/pre-execute', exec, async () => ({}))
  await emit(host.handlers, 'fs/write-intent', file, exec, async () => ({}))
  writeFileSync(file, 'after\n')
  await emit(host.handlers, 'session/event', session, {
    type: 'tool/call', seq: 1, time: 2,
    data: { turn: 1, step: 1, callId: 'call-1', name: 'write', arguments: JSON.stringify({ file_path: file, content: 'after\n' }) },
  })
  await emit(host.handlers, 'session/event', session, {
    type: 'tool/result', seq: 2, time: 3,
    data: {
      turn: 1, step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [{ type: 'text', text: 'created' }], isError: false },
      meta: { path: file, operation: 'create', diffs: [] },
    },
  })
  await emit(host.handlers, 'session/event', session, { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } })
  const dir = sessionReceiptDir(cwd, 'session-restore', { home })
  await until(() => existsSync(join(dir, 'receipt.json')))

  writeFileSync(file, 'manual\n')
  const refused = fakeResponse()
  await host.routes.get('/session-diff/restore')(fakeRequest('/session-diff/restore', { session: 'session-restore', path: 'note.txt' }), refused)
  assert.equal(refused.statusCode, 409)
  assert.match(refused.body, /refusing to overwrite/)

  const forced = fakeResponse()
  await host.routes.get('/session-diff/restore')(fakeRequest('/session-diff/restore', { session: 'session-restore', path: 'note.txt', force: true }), forced)
  assert.equal(forced.statusCode, 200, forced.body)
  assert.equal(readFileSync(file, 'utf8'), 'before\n')
})
