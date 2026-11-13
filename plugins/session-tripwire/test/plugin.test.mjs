/**
 * Host-wiring tests: boot `apply()` over a fake Cordis context, emit Session
 * lifecycle events, and drive the real `tools/pre-execute` /
 * `tools/post-execute` waterfalls. No DSH app is started.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply, targetPaths } from '../index.js'

/** Create one empty workspace. */
async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tripwire-plugin-'))
}

/** Build a fake Cordis context, route table, command table, and listener table. */
function harness(root, config = {}) {
  const listeners = new Map()
  const routes = new Map()
  const commands = new Map()
  const disposers = []
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
    getOrigin: () => 'http://127.0.0.1:12345',
  }
  const commandService = {
    register(definition) {
      commands.set(definition.name, definition)
      return () => commands.delete(definition.name)
    },
  }
  const ctx = {
    webServer,
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
        return true
      }
    },
    effect(effect) {
      const dispose = effect()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'commands') return commandService
      return undefined
    },
    logger: console,
  }
  const handle = apply(ctx, { workspaceRoot: root, mode: 'observe', ttlMs: 60_000, ...config })
  return { ctx, listeners, routes, commands, disposers, handle }
}

/** Wait until a predicate is true. */
async function waitFor(predicate, label, timeout = 4_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Emit one session lifecycle event synchronously. */
function emitSession(h, session) {
  for (const listener of h.listeners.get('session/created') ?? []) listener(session)
}

/** Emit one disposal event synchronously. */
function emitDisposed(h, session) {
  for (const listener of h.listeners.get('session/disposed') ?? []) listener(session)
}

/** Run the first pre-execute waterfall listener. */
async function runPre(h, exec) {
  const listener = (h.listeners.get('tools/pre-execute') ?? [])[0]
  return listener(exec, async () => ({ kind: 'allow' }))
}

/** Run the first post-execute waterfall listener. The default `next()` matches the real pipeline: accept with no content replacement. */
async function runPost(h, exec, result = { isError: false, content: [{ type: 'text', text: 'written' }] }, nextDecision = { kind: 'accept' }) {
  const listener = (h.listeners.get('tools/post-execute') ?? [])[0]
  return listener(exec, result, async () => nextDecision)
}

/** Invoke one HTTP route with an optional JSON body. */
async function invoke(handler, options = {}) {
  const method = options.method ?? 'GET'
  const body = options.body
  const req = {
    method,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  const res = {
    statusCode: 0,
    headers: {},
    payload: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(value) { this.payload = value },
  }
  await handler(req, res)
  return { status: res.statusCode, headers: res.headers, body: res.payload }
}

/** Register one session and wait for its ledger writer. */
async function openSession(h, sessionId, cwd) {
  emitSession(h, { id: sessionId, header: { cwd } })
  await waitFor(async () => (await h.handle.ledger.status()).writers.some(writer => writer.sessionId === sessionId), `writer ${sessionId}`)
}

/** Write one file through the real pre/post hook pair. */
async function writeThrough(h, sessionId, filePath, content, token) {
  const before = await fs.readFile(filePath, 'utf8').catch(() => null)
  const pre = await runPre(h, {
    token,
    name: 'write',
    arguments: { file_path: filePath, content },
    agent: { id: sessionId },
  })
  assert.equal(pre.kind, 'allow')
  await fs.writeFile(filePath, content)
  const post = await runPost(h, {
    token,
    name: 'write',
    arguments: { file_path: filePath, content },
    agent: { id: sessionId },
  })
  assert.equal(post.kind, 'accept')
  return { before, post }
}

test('MVP-1: sessions register on start, routes serve the board, and writes appear on it', async (t) => {
  const root = await workspace()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const h = harness(root)

  await openSession(h, 'sess-alpha', root)
  await openSession(h, 'sess-beta', root)
  const status = await h.handle.ledger.status()
  assert.equal(status.writers.length, 2)
  assert.equal(status.stats.liveWriters, 2)

  const file = path.join(root, 'board.txt')
  await fs.writeFile(file, 'first\n')
  await writeThrough(h, 'sess-alpha', file, 'second\n', 'token-1')

  assert.ok(h.routes.has('/tripwire/board'))
  assert.ok(h.routes.has('/tripwire/state'))
  assert.ok(h.routes.has('/tripwire/action'))
  assert.ok(h.routes.has('/tripwire/health'))
  assert.ok(h.commands.has('tripwire'))

  const board = await invoke(h.routes.get('/tripwire/board'))
  assert.equal(board.status, 200)
  assert.match(board.body, /Session <span>Tripwire<\/span>/u)
  assert.match(board.body, /board\.txt/u)
  assert.match(board.body, /sess-alpha/u)

  const state = await invoke(h.routes.get('/tripwire/state'))
  assert.equal(state.status, 200)
  const payload = JSON.parse(state.body)
  assert.equal(payload.status.writers.length, 2)
  assert.equal(payload.status.writes[0].path, 'board.txt')
})

test('MVP-2: the post-execute hook records the content hash and before/after pair', async (t) => {
  const root = await workspace()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const h = harness(root)
  await openSession(h, 'sess-alpha', root)
  const file = path.join(root, 'hash.txt')
  await fs.writeFile(file, 'before\n')
  const result = await writeThrough(h, 'sess-alpha', file, 'after\n', 'token-2')

  const status = await h.handle.ledger.status()
  assert.equal(status.writes.length, 1)
  assert.equal(status.writes[0].beforeHash.length, 64)
  assert.equal(status.writes[0].hash.length, 64)
  assert.equal(status.writes[0].changed, true)
  assert.notEqual(status.writes[0].beforeHash, status.writes[0].hash)
  assert.equal(result.before, 'before\n')
})

test('MVP-3: warn mode appends the other session id to the allowed write result', async (t) => {
  const root = await workspace()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const h = harness(root)
  await openSession(h, 'sess-alpha', root)
  await openSession(h, 'sess-beta', root)
  await h.handle.ledger.setMode('warn')

  const file = path.join(root, 'warn.txt')
  await fs.writeFile(file, 'alpha\n')
  await writeThrough(h, 'sess-alpha', file, 'alpha v2\n', 'token-alpha')

  const pre = await runPre(h, {
    token: 'token-beta',
    name: 'edit',
    arguments: { file_path: file, old_string: 'alpha v2', new_string: 'beta' },
    agent: { id: 'sess-beta' },
  })
  assert.equal(pre.kind, 'allow')
  await fs.writeFile(file, 'beta\n')
  const post = await runPost(h, {
    token: 'token-beta',
    name: 'edit',
    arguments: { file_path: file, old_string: 'alpha v2', new_string: 'beta' },
    agent: { id: 'sess-beta' },
  })
  assert.equal(post.kind, 'accept')
  const text = post.content.map(block => block.text).join('\n')
  assert.match(text, /Tripwire warning/u)
  assert.match(text, /sess-alpha/u)
  assert.match(text, /write allowed/u)
})

test('MVP-4: block mode denies the call with the typed conflict and leaves the file intact', async (t) => {
  const root = await workspace()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const h = harness(root)
  await openSession(h, 'sess-alpha', root)
  await openSession(h, 'sess-beta', root)
  const file = path.join(root, 'block.txt')
  await fs.writeFile(file, 'alpha owns this\n')
  await writeThrough(h, 'sess-alpha', file, 'alpha still owns this\n', 'token-alpha')
  await h.handle.ledger.setMode('block')

  const blocked = await runPre(h, {
    token: 'token-block',
    name: 'write',
    arguments: { file_path: file, content: 'beta overwrite\n' },
    agent: { id: 'sess-beta' },
  })
  assert.equal(blocked.kind, 'deny')
  assert.equal(blocked.info.name, 'TripwireConflict')
  assert.equal(blocked.info.code, 'TRIPWIRE_CONFLICT')
  assert.match(blocked.reason, /sess-alpha/u)
  assert.match(blocked.reason, /re-read/u)
  assert.match(blocked.reason, /\/tripwire claim/u)
  assert.match(blocked.reason, /stand down/u)
  assert.equal(await fs.readFile(file, 'utf8'), 'alpha still owns this\n')
})

test('MVP-5: the /tripwire command drives claim, release, mode, ignore, and kill switch', async (t) => {
  const root = await workspace()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const h = harness(root)
  await openSession(h, 'sess-alpha', root)
  await openSession(h, 'sess-beta', root)
  const command = h.commands.get('tripwire')

  const status = await command.handler({ rawInput: 'status', agent: { id: 'sess-alpha' } })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /Session Tripwire/u)
  assert.match(status.text, /Board: http:\/\/127\.0\.0\.1:12345\/tripwire\/board/u)

  const claimed = await command.handler({ rawInput: 'claim claimed.txt', agent: { id: 'sess-alpha' } })
  assert.equal(claimed.kind, 'success')
  assert.match(claimed.text, /owns claimed\.txt/u)
  let snapshot = await h.handle.ledger.status()
  assert.equal(snapshot.leases[0].owner, `sess-alpha:${process.pid}`)
  assert.equal(snapshot.leases[0].fence, 1)

  const released = await command.handler({ rawInput: 'release claimed.txt', agent: { id: 'sess-alpha' } })
  assert.equal(released.kind, 'success')
  assert.match(released.text, /released claimed\.txt/u)

  await command.handler({ rawInput: 'mode warn', agent: { id: 'sess-alpha' } })
  assert.equal((await h.handle.ledger.status()).mode, 'warn')
  await command.handler({ rawInput: 'ignore generated/**', agent: { id: 'sess-alpha' } })
  assert.ok((await h.handle.ledger.status()).ignore.some(entry => entry.pattern === 'generated/**'))
  await command.handler({ rawInput: 'unignore generated/**', agent: { id: 'sess-alpha' } })
  assert.ok(!(await h.handle.ledger.status()).ignore.some(entry => entry.pattern === 'generated/**'))
  await command.handler({ rawInput: 'kill', agent: { id: 'sess-alpha' } })
  snapshot = await h.handle.ledger.status()
  assert.equal(snapshot.killSwitch, true)
  await command.handler({ rawInput: 'revive', agent: { id: 'sess-alpha' } })
  assert.equal((await h.handle.ledger.status()).killSwitch, false)
})

test('MVP-5: /tripwire claim resolves a relative path against the session cwd', async (t) => {
  const root = await workspace()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const subdir = path.join(root, 'packages', 'app')
  await fs.mkdir(subdir, { recursive: true })
  const h = harness(root)
  await openSession(h, 'sess-sub', subdir)
  const claimed = await h.commands.get('tripwire').handler({ rawInput: 'claim claim.txt', agent: { id: 'sess-sub' } })
  assert.equal(claimed.kind, 'success', claimed.text)
  const status = await h.handle.ledger.status()
  assert.equal(status.leases[0].path, 'packages/app/claim.txt')
})

test('MVP-6: board actions toggle the kill switch and edit the ignore list', async (t) => {
  const root = await workspace()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const h = harness(root)
  await openSession(h, 'sess-alpha', root)

  const killed = await invoke(h.routes.get('/tripwire/action'), { method: 'POST', body: { action: 'kill' } })
  assert.equal(killed.status, 200)
  assert.equal(JSON.parse(killed.body).status.killSwitch, true)

  const ignored = await invoke(h.routes.get('/tripwire/action'), { method: 'POST', body: { action: 'ignore', pattern: 'tmp/**' } })
  assert.equal(ignored.status, 200)
  const state = JSON.parse((await invoke(h.routes.get('/tripwire/state'))).body)
  assert.ok(state.status.ignore.some(entry => entry.pattern === 'tmp/**'))
  assert.match((await invoke(h.routes.get('/tripwire/board'))).body, /tmp\/\*\*/u)

  const revived = await invoke(h.routes.get('/tripwire/action'), { method: 'POST', body: { action: 'revive' } })
  assert.equal(JSON.parse(revived.body).status.killSwitch, false)

  const bad = await invoke(h.routes.get('/tripwire/action'), { method: 'POST', body: { action: 'nope' } })
  assert.equal(bad.status, 400)
  assert.match(JSON.parse(bad.body).error, /unknown action/u)
})

test('MVP-3: observe records the overlapping write without taking the lease', async (t) => {
  const root = await workspace()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const h = harness(root)
  await openSession(h, 'sess-alpha', root)
  await openSession(h, 'sess-beta', root)
  const file = path.join(root, 'observe.txt')
  await fs.writeFile(file, 'alpha\n')
  await writeThrough(h, 'sess-alpha', file, 'alpha v2\n', 'token-alpha')
  await h.handle.ledger.setMode('observe')

  const pre = await runPre(h, {
    token: 'token-observe',
    name: 'write',
    arguments: { file_path: file, content: 'beta observed\n' },
    agent: { id: 'sess-beta' },
  })
  assert.equal(pre.kind, 'allow')
  await fs.writeFile(file, 'beta observed\n')
  const post = await runPost(h, {
    token: 'token-observe',
    name: 'write',
    arguments: { file_path: file, content: 'beta observed\n' },
    agent: { id: 'sess-beta' },
  })
  assert.equal(post.kind, 'accept')

  const status = await h.handle.ledger.status()
  assert.equal(status.leases[0].owner, `sess-alpha:${process.pid}`)
  const last = status.writes.find(write => write.path === 'observe.txt')
  assert.equal(last.writerId, `sess-beta:${process.pid}`)
  assert.equal(last.preservedLease, true)
  assert.equal(last.fence, null)
})

test('MVP-4: a multi-file patch blocked on the second target releases the first lease', async (t) => {
  const root = await workspace()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const h = harness(root)
  await openSession(h, 'sess-alpha', root)
  await openSession(h, 'sess-beta', root)
  const heldFile = path.join(root, 'b.txt')
  await fs.writeFile(heldFile, 'beta owns b\n')
  await writeThrough(h, 'sess-beta', heldFile, 'beta still owns b\n', 'token-beta')
  await h.handle.ledger.setMode('block')

  const blocked = await runPre(h, {
    token: 'token-patch',
    name: 'apply_patch',
    arguments: {
      input: [
        '*** Begin Patch',
        '*** Add File: a.txt',
        '+alpha creates a',
        '*** Update File: b.txt',
        '@@',
        '-beta still owns b',
        '+alpha overwrite',
        '*** End Patch',
      ].join('\n'),
    },
    agent: { id: 'sess-alpha' },
  })
  assert.equal(blocked.kind, 'deny')
  assert.equal(blocked.info.code, 'TRIPWIRE_CONFLICT')
  const status = await h.handle.ledger.status()
  assert.ok(!status.leases.some(lease => lease.path === 'a.txt'))
  assert.equal(status.leases.find(lease => lease.path === 'b.txt').owner, `sess-beta:${process.pid}`)
})

test('apply_patch and str_replace_editor targets are extracted before dispatch', () => {
  const root = path.resolve('C:/workspace')
  const patch = targetPaths('apply_patch', {
    input: [
      '*** Begin Patch',
      '*** Add File: src/new.js',
      '+export const x = 1',
      '*** Update File: src/old.js',
      '*** Move to: src/moved.js',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n'),
  }, root)
  assert.deepEqual(patch, [
    path.resolve(root, 'src/new.js'),
    path.resolve(root, 'src/old.js'),
    path.resolve(root, 'src/moved.js'),
  ])
  assert.deepEqual(targetPaths('str_replace_editor', { command: 'view', path: path.join(root, 'view.txt') }, root), [])
  assert.deepEqual(targetPaths('str_replace_editor', { command: 'str_replace', path: path.join(root, 'edit.txt') }, root), [path.join(root, 'edit.txt')])
  assert.deepEqual(targetPaths('write', { file_path: 'relative.txt' }, root), [path.resolve(root, 'relative.txt')])
})
