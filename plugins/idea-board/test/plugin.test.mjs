/**
 * Integration test for the host half: boot `apply()` over a fake Cordis context,
 * then exercise the `/dream` command and the `/dream-board/brief` route. This
 * catches wiring mistakes without starting the full DSH app.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { sessionReceiptDir } from '../../session-diff/src/snapshots.mjs'

/** One dream document recognized by the store. */
const DREAM = {
  id: 'drm_wiring12345',
  title: 'Wiring Packet',
  pitch: 'Prove the host command and route render a packet.',
  type: 'feature',
  problem: 'Integration is untested.',
  targetUser: 'Plugin author.',
  value: 'The route and command share one renderer.',
  monetization: 'n/a',
  competitive: { summary: '', competitors: [{ name: 'None', url: '', pricing: '', gap: '' }] },
  architecture: 'Host plugin.',
  mvpScope: ['Render the packet', 'Write the checks file'],
  effort: '1 day',
  sources: { web: [], ideas: [], sessions: [] },
  scores: { value: 3, niche: 3, revenue: 1, feasibility: 5, fit: 5 },
  totalScore: 17,
  iterationCount: 1,
  status: 'ready_for_review',
  tags: [],
}

/** One failing dsh-doctor finding, in the shape a `--json` report carries. */
const DOCTOR_FAILURE = {
  id: 'plugin.duplicate-id',
  group: 'plugin',
  severity: 'error',
  title: 'Unique plugin ids',
  status: 'fail',
  summary: '1 plugin id is provided by more than one package',
  evidence: [{ path: 'turn-cost/package.json', detail: '@local/turn-cost is also declared by turn-cost.backup-20261110' }],
  fix: { type: 'manual', summary: 'remove or rename the duplicate package', steps: ['keep one of them'] },
}

/** A storage unit over in-memory tables. */
function unit(tables) {
  return {
    tables,
    async loadAll() { return { tables } },
    async putRecord(table, key, value) { (tables[table] ??= {})[key] = value },
    async deleteRecord(table, key) { if (tables[table] !== undefined) delete tables[table][key] },
    async close() {},
  }
}

/** Build a fake Cordis context and the temp project the packet scans. */
async function harness(options = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dream-plugin-'))
  await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'wiring-fixture', scripts: { test: 'node --test' } }))
  await fs.mkdir(path.join(cwd, 'src'))
  await fs.writeFile(path.join(cwd, 'src', 'app.js'), 'export {}\n')

  const boardTables = { dreams: { [DREAM.id]: structuredClone(DREAM) }, meta: { current: { version: 1, revision: 1, scheduleId: null, scheduleSignature: null, lock: null } } }
  const discardTables = { entries: {} }
  const units = {
    idea_board: unit({ state: { current: { version: 1, revision: 0, items: [], ui: {} } } }),
    dream_board: unit(boardTables),
    dream_discards: unit(discardTables),
    dream_runs: unit({ runs: {} }),
    nightmare_board: unit({ nightmares: {}, meta: {} }),
  }
  const scheduleCalls = { created: [], edited: [], runs: 0 }
  const schedule = options.schedule === true ? {
    async create(request) {
      scheduleCalls.created.push(request)
      return { id: 'schedule-fake', title: request.title, status: 'active', scheduledAt: '2026-11-11T10:00:00.000Z' }
    },
    async run() {
      scheduleCalls.runs += 1
      if (typeof options.runError === 'string') throw new Error(options.runError)
      return { lastDelivery: { targetSessionId: 'session-fake' } }
    },
    async edit(request) {
      scheduleCalls.edited.push(request)
      return {}
    },
    async catalog() {
      return scheduleCalls.created.map((request) => ({
        id: 'schedule-fake', title: request.title, target: request.target, status: 'active', scheduledAt: '2026-11-11T10:00:00.000Z',
      }))
    },
  } : undefined
  const routes = new Map()
  const commands = new Map()
  const toolRegistry = new Map()
  const disposers = []
  const webServer = { register: (route) => { routes.set(route.path, route.handler); return () => {} } }
  const activityHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dream-activity-home-'))
  const sessionRecords = [{ header: { id: 'session-activity', origin: 'cli', isSeeded: false, cwd, createdAt: 1 } }]
  const sessionQuery = {
    async listSessions() { return sessionRecords },
    async readTitleSnapshots(ids) {
      return ids.map(id => ({ status: 'fulfilled', sessionId: id, value: { title: { title: 'Activity fixture' } } }))
    },
    async filterEvents() { return [] },
  }
  const ctx = {
    webServer,
    get(name) {
      if (name === 'storage') {
        return {
          backend: {
            names: () => ['json'],
            get: () => ({ kv: { open: async (descriptor) => units[descriptor.name] } }),
          },
        }
      }
      if (name === 'webServer') return webServer
      if (name === 'commands') return { register: (definition) => { commands.set(definition.name, definition); return () => {} } }
      if (name === 'schedule') return schedule
      if (name === 'sessionQuery') return sessionQuery
      if (name === 'tools') return { register: (definition) => { toolRegistry.set(definition.name, definition); return () => {} } }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    inject() {},
    on() {},
  }
  apply(ctx, {
    autoSchedule: false,
    projectCwd: cwd,
    maxActiveDreams: 10,
    activityHome,
    doctorScript: options.doctorScript ?? '',
  })
  return { cwd, routes, commands, disposers, units, scheduleCalls, toolRegistry, activityHome }
}

/** Invoke one captured HTTP route with a JSON body. */
async function post(handler, body) {
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body))
    },
  }
  const response = { statusCode: 0, headers: {}, payload: null }
  response.setHeader = (name, value) => { response.headers[name] = value }
  response.end = (value) => { response.payload = value }
  await handler(req, response)
  return { status: response.statusCode, headers: response.headers, body: JSON.parse(response.payload) }
}

/** Invoke one captured HTTP route with a bodyless GET. */
async function get(handler) {
  const req = { method: 'GET', headers: {} }
  const response = { statusCode: 0, headers: {}, payload: null }
  response.setHeader = (name, value) => { response.headers[name] = value }
  response.end = (value) => { response.payload = value }
  await handler(req, response)
  return {
    status: response.statusCode,
    headers: response.headers,
    body: response.payload === undefined ? undefined : JSON.parse(response.payload),
  }
}

/** Invoke one captured HTTP route with a JSON PUT body. */
async function putState(handler, body) {
  const req = {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body))
    },
  }
  const response = { statusCode: 0, headers: {}, payload: null }
  response.setHeader = (name, value) => { response.headers[name] = value }
  response.end = (value) => { response.payload = value }
  await handler(req, response)
  return { status: response.statusCode, headers: response.headers, body: JSON.parse(response.payload) }
}

test('apply registers the dream command, brief route, and existing routes', async () => {
  const { routes, commands, toolRegistry } = await harness()
  assert.ok(commands.has('dream'))
  assert.ok(commands.has('dreamer'))
  assert.ok(routes.has('/dream-board/brief'))
  assert.ok(routes.has('/dream-board/pursue'))
  assert.ok(routes.has('/idea-board/state'))
  assert.ok(routes.has('/nightmare-board/state'))
  assert.ok(routes.has('/nightmare-board/decide'))
  assert.ok(routes.has('/nightmare-board/run'))
  for (const name of ['nightmare_add', 'nightmare_list', 'nightmare_decide']) {
    assert.ok(toolRegistry.has(name), `${name} is registered`)
  }
})

test('the nightmare board ingests doctor findings and requires a comment to ignore one', async () => {
  const h = await harness()

  const add = h.toolRegistry.get('nightmare_add')
  assert.ok(add, 'nightmare_add is registered')
  const ingested = await add.execute({ findings: [DOCTOR_FAILURE] }, { agent: { id: 'session-run' } })
  assert.equal(ingested.added, 1)
  assert.equal(ingested.updated, 0)

  const listed = await get(h.routes.get('/nightmare-board/state'))
  assert.equal(listed.status, 200)
  assert.equal(listed.body.ok, true)
  assert.equal(listed.body.board.nightmares.length, 1)
  const [nightmare] = listed.body.board.nightmares
  assert.equal(nightmare.status, 'open')
  assert.equal(nightmare.checkId, 'plugin.duplicate-id')

  const missingComment = await post(h.routes.get('/nightmare-board/decide'), { id: nightmare.id, action: 'ignore' })
  assert.equal(missingComment.status, 400)
  assert.equal(missingComment.body.ok, false)

  const unchanged = await get(h.routes.get('/nightmare-board/state'))
  assert.equal(unchanged.body.board.nightmares[0].status, 'open')

  const decided = await post(h.routes.get('/nightmare-board/decide'), {
    id: nightmare.id,
    action: 'ignore',
    comment: 'the backup package is intentional',
  })
  assert.equal(decided.status, 200)
  assert.equal(decided.body.ok, true)
  assert.equal(decided.body.nightmare.status, 'ignored')
  assert.equal(decided.body.nightmare.decision.comment, 'the backup package is intentional')

  const unknown = await post(h.routes.get('/nightmare-board/decide'), { id: 'nrm_missing', action: 'accept' })
  assert.equal(unknown.status, 404)

  const stateWrongMethod = await post(h.routes.get('/nightmare-board/state'), {})
  assert.equal(stateWrongMethod.status, 405)
  assert.equal(stateWrongMethod.headers.allow, 'GET')

  const decideWrongMethod = await get(h.routes.get('/nightmare-board/decide'))
  assert.equal(decideWrongMethod.status, 405)
  assert.equal(decideWrongMethod.headers.allow, 'POST')
})

test('squashing a nightmare starts one Fleet session and marks it accepted', async () => {
  const h = await harness({ schedule: true })
  const add = h.toolRegistry.get('nightmare_add')
  await add.execute({ findings: [DOCTOR_FAILURE] }, { agent: { id: 'session-run' } })
  const listed = await get(h.routes.get('/nightmare-board/state'))
  const [nightmare] = listed.body.board.nightmares

  const squashed = await post(h.routes.get('/nightmare-board/squash'), { id: nightmare.id })
  assert.equal(squashed.status, 200)
  assert.equal(squashed.body.ok, true)
  assert.equal(squashed.body.sessionId, 'session-fake')
  assert.equal(squashed.body.nightmare.status, 'accepted')
  assert.equal(squashed.body.nightmare.squashSessionId, 'session-fake')
  assert.equal(h.scheduleCalls.created.length, 1, 'one launch per squash')
  assert.equal(h.scheduleCalls.created[0].title, 'Squash nightmare: plugin.duplicate-id')
  assert.match(h.scheduleCalls.created[0].prompt, /--check plugin\.duplicate-id/)
  assert.equal(h.scheduleCalls.created[0].target.create.agentPreset, 'fleet')
  assert.equal(h.scheduleCalls.edited.length, 1, 'the one-shot task is deleted after launch')
  assert.equal(h.scheduleCalls.runs, 1)

  const missing = await post(h.routes.get('/nightmare-board/squash'), { id: 'nrm_missing' })
  assert.equal(missing.status, 404)

  const wrongMethod = await get(h.routes.get('/nightmare-board/squash'))
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')
})

test('squashing without a schedule service reports the failure instead of pretending', async () => {
  const h = await harness()
  await h.toolRegistry.get('nightmare_add').execute({ findings: [DOCTOR_FAILURE] }, { agent: { id: 'session-run' } })
  const [nightmare] = (await get(h.routes.get('/nightmare-board/state'))).body.board.nightmares
  const result = await post(h.routes.get('/nightmare-board/squash'), { id: nightmare.id })
  assert.equal(result.status, 503)
  assert.equal(result.body.ok, false)
  assert.match(String(result.body.error), /schedule/)
  const after = await get(h.routes.get('/nightmare-board/state'))
  assert.equal(after.body.board.nightmares[0].status, 'open', 'a failed launch must not mark it accepted')
})

test('a passing check closes its nightmare through nightmare_add', async () => {
  const h = await harness()
  const add = h.toolRegistry.get('nightmare_add')

  await add.execute({ findings: [DOCTOR_FAILURE] }, { agent: { id: 'session-run' } })
  const first = await get(h.routes.get('/nightmare-board/state'))
  assert.equal(first.body.board.nightmares[0].status, 'open')

  const closed = await add.execute({ findings: [], passing: ['plugin.duplicate-id'] }, { agent: { id: 'session-run' } })
  assert.equal(closed.cleared, 1)

  const after = await get(h.routes.get('/nightmare-board/state'))
  assert.equal(after.body.board.nightmares[0].status, 'fixed')
  assert.match(after.body.board.nightmares[0].decision.comment, /now passes/)
  assert.equal(after.body.board.counts.open, 0)
})

test('the /dream command lists dreams and renders a packet', async () => {
  const { cwd, commands } = await harness()
  const command = commands.get('dream')
  const listed = await command.handler({ rawInput: '' })
  assert.equal(listed.kind, 'success')
  assert.match(listed.text, /drm_wiring12345 — Wiring Packet/)

  const written = await command.handler({ rawInput: 'brief drm_wiring12345 --out packets' })
  assert.equal(written.kind, 'success', written.text)
  assert.match(written.text, /Packet: packets\/wiring-packet\.md/)
  assert.match(written.text, /Checks: packets\/wiring-packet\.checks\.json \(2 checks\)/)
  const packet = await fs.readFile(path.join(cwd, 'packets', 'wiring-packet.md'), 'utf8')
  assert.ok(packet.includes('# Build packet: Wiring Packet'))
  const checks = JSON.parse(await fs.readFile(path.join(cwd, 'packets', 'wiring-packet.checks.json'), 'utf8'))
  assert.equal(checks.checks.length, 2)
  assert.ok(checks.checks.every((entry) => entry.status === 'pending'))

  const unknown = await command.handler({ rawInput: 'brief drm_wiring12345 --bogus' })
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /Unknown option/)

  const missingOut = await command.handler({ rawInput: 'brief drm_wiring12345 --out' })
  assert.equal(missingOut.kind, 'error')
  assert.match(missingOut.text, /--out needs a directory/)
})

test('the brief route writes the packet, and attach false does not retire the dream', async () => {
  const { cwd, routes } = await harness()
  const result = await post(routes.get('/dream-board/brief'), { id: 'drm_wiring12345', outDir: 'briefs' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.briefPath, 'briefs/wiring-packet.md')
  assert.equal(result.body.checkCount, 2)
  assert.equal(result.body.sessionId, undefined)
  const packet = await fs.readFile(path.join(cwd, 'briefs', 'wiring-packet.md'), 'utf8')
  assert.ok(packet.includes('Prove the host command and route render a packet.'))
  const state = await post(routes.get('/dream-board/state'), {})
  assert.equal(state.status, 405)
})

test('the /dream command forwards --attach to the Fleet launch', async () => {
  const h = await harness({ schedule: true })
  const result = await h.commands.get('dream').handler({ rawInput: 'brief drm_wiring12345 --attach' })
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /Fleet buildout started for "Wiring Packet"/)
  assert.match(result.text, /Session: session-fake/)
  assert.equal(h.scheduleCalls.created.length, 1)
  assert.equal(h.scheduleCalls.edited[0].action, 'delete')
  assert.equal(h.units.dream_board.tables.dreams[DREAM.id], undefined)
})

test('the brief route rejects an unknown dream and a path escape', async () => {
  const { routes } = await harness()
  const unknown = await post(routes.get('/dream-board/brief'), { id: 'drm_missing' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.ok, false)
  const escape = await post(routes.get('/dream-board/brief'), { id: 'drm_wiring12345', outDir: '../outside' })
  assert.equal(escape.status, 503)
  assert.match(escape.body.error, /inside the project/)
})

test('attach writes the packet, seeds the Fleet prompt, retires the dream, and deletes the one-shot task', async () => {
  const h = await harness({ schedule: true })
  const result = await post(h.routes.get('/dream-board/brief'), { id: DREAM.id, attach: true })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.sessionId, 'session-fake')
  assert.equal(result.body.briefPath, 'briefs/wiring-packet.md')

  const created = h.scheduleCalls.created[0]
  assert.equal(created.title, 'Dream buildout: Wiring Packet')
  assert.equal(created.target.create.agentPreset, 'fleet')
  assert.equal(created.timing.kind, 'after')
  assert.equal(created.timing.after_seconds, 60)
  assert.match(created.prompt, /# Build packet: Wiring Packet/)
  assert.match(created.prompt, /briefs\/wiring-packet\.checks\.json/)
  assert.equal(h.scheduleCalls.edited[0].action, 'delete')

  assert.equal(h.units.dream_board.tables.dreams[DREAM.id], undefined)
  const discards = Object.values(h.units.dream_discards.tables.entries)
  assert.equal(discards.length, 1)
  assert.equal(discards[0].outcome, 'pursued')
  assert.match(discards[0].reason, /packet briefs\/wiring-packet\.md/)
})

test('a failed Fleet launch deletes the task, keeps the dream active, and writes no discard entry', async () => {
  const h = await harness({ schedule: true, runError: 'launch failed' })
  const result = await post(h.routes.get('/dream-board/brief'), { id: DREAM.id, attach: true })
  assert.equal(result.status, 503)
  assert.match(result.body.error, /launch failed/)
  assert.ok(h.units.dream_board.tables.dreams[DREAM.id])
  assert.equal(Object.keys(h.units.dream_discards.tables.entries).length, 0)
  assert.equal(h.scheduleCalls.edited[0].action, 'delete')
})

test('a changed Dreamer prompt refreshes the managed task', async () => {
  const h = await harness({ schedule: true })
  await h.toolRegistry.get('dream_context').execute({}, { agent: { id: 'session-run' } })
  assert.equal(h.scheduleCalls.created.length, 1)
  assert.match(h.scheduleCalls.created[0].prompt, /Quality over quantity/)
  assert.match(h.scheduleCalls.created[0].prompt, /pursued/)
  h.units.dream_board.tables.meta.current.scheduleSignature = 'stale-signature'
  await h.toolRegistry.get('dream_context').execute({}, { agent: { id: 'session-run' } })
  assert.equal(h.scheduleCalls.edited.length, 1)
  assert.match(h.scheduleCalls.edited[0].patch.prompt, /Quality over quantity/)
  assert.match(h.scheduleCalls.edited[0].patch.prompt, /pursued/)
})

test('dream_context is compact and dream_get returns the full record', async () => {
  const h = await harness()
  const context = await h.toolRegistry.get('dream_context').execute({}, { agent: { id: 'session-run' } })
  assert.ok(Array.isArray(context.pursued))
  assert.ok(Array.isArray(context.boardWarnings))
  assert.equal(context.dreams[0].architecture, undefined)
  assert.ok(Array.isArray(context.dreams[0].missing))
  assert.equal(context.caps.maxNewDreamsPerRun, 1)

  const get = h.toolRegistry.get('dream_get')
  assert.ok(get, 'dream_get is registered')
  const full = await get.execute({ id: DREAM.id })
  assert.equal(full.dream.id, DREAM.id)
  assert.equal(typeof full.dream.architecture, 'string')
  await assert.rejects(() => get.execute({ id: 'drm_missing' }), /unknown dream/)
})

test('dream_context carries deterministic activity receipts for recent sessions', async () => {
  const h = await harness()
  const dir = sessionReceiptDir(h.cwd, 'session-activity', { home: h.activityHome })
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'receipt.json'), JSON.stringify({
    version: 1,
    kind: 'session-receipt',
    generatedAt: 10,
    session: { id: 'session-activity', cwd: h.cwd, startedAt: 1_000, endedAt: 2_000, durationMs: 1_000 },
    summary: {
      filesAdded: 2, filesModified: 1, filesDeleted: 0, commands: 1, commandsFailed: 1,
      openThreads: 1, models: 1, totalCostUsd: 0.5,
    },
    files: [
      { path: 'src/app.js', status: 'added' },
      { path: 'src/worker.js', status: 'added' },
      { path: 'src/app.js', status: 'modified' },
    ],
    commands: [{ seq: 4, command: 'npm test', exitCode: 1, firstFailureLine: 'AssertionError: 1 !== 2' }],
    threads: [{ kind: 'failed-tests', detail: 'AssertionError: 1 !== 2', ref: 4 }],
    models: [{ provider: 'deepseek-account', model: 'deepseek-flash', costUsd: 0.5 }],
  }), 'utf8')

  const tool = h.toolRegistry.get('dream_context')
  assert.ok(tool, 'dream_context is registered')
  const context = await tool.execute({}, { agent: { id: 'session-dreamer-run' } })
  assert.equal(context.locked, false)
  assert.equal(context.activity.rollup.sessions, 1)
  assert.equal(context.activity.sessions[0].id, 'session-activity')
  assert.equal(context.activity.sessions[0].source, 'stored')
  assert.equal(context.activity.rollup.files.added, 2)
  assert.equal(context.activity.rollup.commands.failed, 1)
  assert.equal(context.activity.rollup.costUsd, 0.5)
  assert.equal(context.activity.sessions[0].failingCommands[0].firstFailureLine, 'AssertionError: 1 !== 2')
})

test('idea layout state keeps the docked size and the nightmares tab', async () => {
  const h = await harness()
  const before = await get(h.routes.get('/idea-board/state'))
  assert.equal(before.status, 200)

  const saved = await putState(h.routes.get('/idea-board/state'), {
    baseRevision: before.body.state.revision,
    state: {
      items: [],
      ui: { collapsed: false, docked: true, x: 12, y: 20, width: 520, height: 360, tab: 'nightmares', wide: false },
    },
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.state.ui, {
    collapsed: false, docked: true, x: 12, y: 20, width: 520, height: 360, tab: 'nightmares', wide: false,
  })

  const clamped = await putState(h.routes.get('/idea-board/state'), {
    baseRevision: saved.body.state.revision,
    state: { items: [], ui: { width: 10, height: 99999, tab: 'unknown' } },
  })
  assert.equal(clamped.status, 200)
  assert.equal(clamped.body.state.ui.width, 240)
  assert.equal(clamped.body.state.ui.height, 4000)
  assert.equal(clamped.body.state.ui.tab, 'ideas')
})

test('the run route ingests a doctor feed and closes a check that now passes', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-fixture-'))
  const feedPath = path.join(fixture, 'feed.json')
  const scriptPath = path.join(fixture, 'doctor.mjs')
  await fs.writeFile(scriptPath, [
    "import { readFileSync } from 'node:fs'",
    "process.stdout.write(readFileSync(new URL('./feed.json', import.meta.url), 'utf8'))",
    'process.exit(1)',
    '',
  ].join('\n'), 'utf8')
  await fs.writeFile(feedPath, JSON.stringify({ source: 'dsh-doctor', findings: [DOCTOR_FAILURE], passing: [] }), 'utf8')

  const h = await harness({ doctorScript: scriptPath })
  const first = await post(h.routes.get('/nightmare-board/run'), {})
  assert.equal(first.status, 200)
  assert.equal(first.body.run.skipped, false)
  assert.equal(first.body.run.added, 1)
  assert.equal(first.body.board.counts.open, 1)

  await fs.writeFile(feedPath, JSON.stringify({
    source: 'dsh-doctor',
    findings: [],
    passing: [DOCTOR_FAILURE.id],
  }), 'utf8')
  const second = await post(h.routes.get('/nightmare-board/run'), {})
  assert.equal(second.status, 200)
  assert.equal(second.body.run.cleared, 1)
  assert.equal(second.body.board.counts.fixed, 1)
  assert.equal(second.body.board.counts.open, 0)
})

