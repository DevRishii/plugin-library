/**
 * Ledger behavior tests. Each test maps to one MVP bullet in
 * `briefs/session-tripwire.checks.json` and uses a clean temporary workspace.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { renderBoard } from '../board.js'
import {
  TRIPWIRE_CONFLICT,
  TripwireLedger,
  globToRegExp,
  hashText,
  normalizePath,
  shortHash,
} from '../ledger.js'

/** Create one empty workspace. */
async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tripwire-ledger-'))
}

/** Remove one workspace. */
async function cleanup(root) {
  await fs.rm(root, { recursive: true, force: true })
}

/** Read one file if it exists. */
async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/** Register one writer and return its id. */
async function register(ledger, sessionId, pid) {
  const writer = await ledger.registerWriter({ sessionId, cwd: ledger.root, pid })
  return writer.id
}

test('MVP-1: sessions register against one workspace-scoped ledger and survive reopen', async (t) => {
  const root = await workspace()
  t.after(() => cleanup(root))
  let clock = 1_000_000
  const ledger = new TripwireLedger({ root, now: () => clock, ttlMs: 60_000 })
  await ledger.open()
  const alpha = await register(ledger, 'sess-alpha', 1111)
  const beta = await register(ledger, 'sess-beta', 2222)

  const status = await ledger.status()
  assert.equal(status.writers.length, 2)
  assert.deepEqual(status.writers.map(writer => writer.id).sort(), [alpha, beta].sort())
  assert.ok(status.writers.every(writer => writer.live))
  assert.equal(status.root, root)
  assert.ok(await exists(path.join(root, '.dsh', 'tripwire', 'state.json')))
  const journal = await fs.readFile(path.join(root, '.dsh', 'tripwire', 'journal.jsonl'), 'utf8')
  assert.match(journal, /"type":"writer\/register"/u)
  assert.match(journal, /sess-alpha/u)
  assert.match(journal, /sess-beta/u)

  clock += 5_000
  const reopened = new TripwireLedger({ root, now: () => clock, ttlMs: 60_000 })
  await reopened.open()
  const again = await reopened.status()
  assert.equal(again.writers.length, 2)
  assert.ok(again.writers.some(writer => writer.sessionId === 'sess-alpha'))
})

test('MVP-1: the journal replays when the snapshot is missing', async (t) => {
  const root = await workspace()
  t.after(() => cleanup(root))
  const ledger = new TripwireLedger({ root, now: () => 1_000_000 })
  await ledger.open()
  await ledger.registerWriter({ sessionId: 'sess-replay', cwd: root, pid: 3333 })
  await fs.rm(path.join(root, '.dsh', 'tripwire', 'state.json'))

  const reopened = new TripwireLedger({ root, now: () => 1_000_100 })
  await reopened.open()
  const status = await reopened.status()
  assert.equal(status.writers.length, 1)
  assert.equal(status.writers[0].sessionId, 'sess-replay')
})

test('MVP-2: each write records a content hash and the changed hashes are visible later', async (t) => {
  const root = await workspace()
  t.after(() => cleanup(root))
  let clock = 2_000_000
  const ledger = new TripwireLedger({ root, now: () => clock })
  await ledger.open()
  const writerId = await register(ledger, 'sess-writer', 4444)
  const file = path.join(root, 'notes.md')
  await fs.writeFile(file, 'first version\n')

  const intent = await ledger.beginWrite({ writerId, sessionId: 'sess-writer', absPath: file, tool: 'write' })
  assert.equal(intent.action, 'allow')
  assert.equal(intent.beforeHash, hashText('first version\n'))

  clock += 10
  await fs.writeFile(file, 'second version\n')
  const recorded = await ledger.recordWrite({
    writerId,
    sessionId: 'sess-writer',
    absPath: file,
    fence: intent.lease.fence,
    tool: 'write',
    beforeHash: intent.beforeHash,
  })
  assert.equal(recorded.stale, false)
  assert.equal(recorded.write.hash, hashText('second version\n'))
  assert.equal(recorded.write.beforeHash, hashText('first version\n'))
  assert.equal(recorded.write.changed, true)

  const status = await ledger.status()
  assert.equal(status.writes[0].path, 'notes.md')
  assert.equal(status.writes[0].hash, hashText('second version\n'))
  assert.equal(shortHash(status.writes[0].beforeHash), hashText('first version\n').slice(0, 12))

  await register(ledger, 'sess-later', 5555)
  const laterStatus = await ledger.status()
  assert.equal(laterStatus.writes[0].hash, hashText('second version\n'))
  assert.equal(laterStatus.writes[0].beforeHash, hashText('first version\n'))
  const journal = await fs.readFile(path.join(root, '.dsh', 'tripwire', 'journal.jsonl'), 'utf8')
  assert.match(journal, /"type":"write"/u)
  assert.ok(journal.includes(hashText('second version\n')))
})

test('MVP-3: warn mode injects the conflicting session id into the tool result', async (t) => {
  const root = await workspace()
  t.after(() => cleanup(root))
  const clock = 3_000_000
  const ledger = new TripwireLedger({ root, now: () => clock })
  await ledger.open()
  const alpha = await register(ledger, 'sess-alpha', 6666)
  const beta = await register(ledger, 'sess-beta', 7777)
  const file = path.join(root, 'shared.txt')
  await fs.writeFile(file, 'alpha owns this\n')

  const first = await ledger.beginWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, tool: 'write' })
  await ledger.recordWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, fence: first.lease.fence, beforeHash: first.beforeHash })

  const warned = await ledger.beginWrite({ writerId: beta, sessionId: 'sess-beta', absPath: file, tool: 'edit', mode: 'warn' })
  assert.equal(warned.action, 'warn')
  assert.equal(warned.conflict.otherSessionId, 'sess-alpha')
  assert.match(warned.warning, /sess-alpha/u)
  assert.match(warned.warning, /write allowed/u)

  const observed = await ledger.beginWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, tool: 'edit', mode: 'observe' })
  assert.equal(observed.action, 'allow')
  assert.equal(observed.conflict.otherSessionId, 'sess-beta')
  assert.equal(observed.conflict.decision, 'observed')
  assert.equal(observed.observeOnly, true)
  // Observe is log-only: beta keeps the lease even though alpha's write proceeds.
  const afterObserve = await ledger.status()
  assert.equal(afterObserve.leases[0].owner, beta)

  const status = await ledger.status()
  assert.equal(status.conflicts[0].decision, 'observed')
  assert.ok(status.conflicts.some(conflict => conflict.decision === 'warned' && conflict.otherSessionId === 'sess-alpha'))
})

test('MVP-4: block mode returns a typed conflict and all three remediation choices', async (t) => {
  const root = await workspace()
  t.after(() => cleanup(root))
  const ledger = new TripwireLedger({ root, now: () => 4_000_000 })
  await ledger.open()
  const alpha = await register(ledger, 'sess-alpha', 8888)
  const beta = await register(ledger, 'sess-beta', 9999)
  const file = path.join(root, 'protected.md')
  await fs.writeFile(file, 'alpha content\n')
  const first = await ledger.beginWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, tool: 'write' })
  await ledger.recordWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, fence: first.lease.fence, beforeHash: first.beforeHash })

  const blocked = await ledger.beginWrite({ writerId: beta, sessionId: 'sess-beta', absPath: file, tool: 'write', mode: 'block' })
  assert.equal(blocked.action, 'block')
  assert.equal(blocked.info.name, 'TripwireConflict')
  assert.equal(blocked.info.code, TRIPWIRE_CONFLICT)
  assert.match(blocked.reason, /TRIPWIRE_CONFLICT/u)
  assert.match(blocked.reason, /sess-alpha/u)
  assert.match(blocked.reason, /re-read/u)
  assert.match(blocked.reason, /\/tripwire claim/u)
  assert.match(blocked.reason, /stand down/u)

  const status = await ledger.status()
  assert.equal(status.leases[0].owner, alpha)
  assert.equal(status.conflicts[0].decision, 'blocked')
  assert.equal(await fs.readFile(file, 'utf8'), 'alpha content\n')
})

test('MVP-5: leases expire by TTL, fences reject stale writers, and claims transfer ownership', async (t) => {
  const root = await workspace()
  t.after(() => cleanup(root))
  let clock = 5_000_000
  const ledger = new TripwireLedger({ root, now: () => clock, ttlMs: 1_000 })
  await ledger.open()
  const alpha = await register(ledger, 'sess-alpha', 1111)
  const beta = await register(ledger, 'sess-beta', 2222)
  const file = path.join(root, 'lease.txt')
  await fs.writeFile(file, 'alpha\n')

  const first = await ledger.beginWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, tool: 'write' })
  assert.equal(first.lease.fence, 1)
  await ledger.recordWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, fence: first.lease.fence, beforeHash: first.beforeHash })

  clock += 500
  const stillHeld = await ledger.beginWrite({ writerId: beta, sessionId: 'sess-beta', absPath: file, tool: 'write', mode: 'block' })
  assert.equal(stillHeld.action, 'block')

  clock += 600
  const afterExpiry = await ledger.beginWrite({ writerId: beta, sessionId: 'sess-beta', absPath: file, tool: 'write', mode: 'block' })
  assert.equal(afterExpiry.action, 'allow')
  assert.equal(afterExpiry.lease.fence, 2)

  await fs.writeFile(file, 'beta\n')
  await ledger.recordWrite({ writerId: beta, sessionId: 'sess-beta', absPath: file, fence: afterExpiry.lease.fence, beforeHash: afterExpiry.beforeHash })
  const stale = await ledger.recordWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, fence: first.lease.fence, beforeHash: first.beforeHash })
  assert.equal(stale.stale, true)
  assert.equal(stale.holder.owner, beta)

  const claim = await ledger.claim({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, reason: 'test-claim' })
  assert.equal(claim.owner, alpha)
  assert.equal(claim.fence, 3)

  await ledger.markOffline(alpha)
  clock += 1_100
  const revived = await ledger.beginWrite({ writerId: beta, sessionId: 'sess-beta', absPath: file, tool: 'write', mode: 'block' })
  assert.equal(revived.action, 'allow')
  const status = await ledger.status()
  assert.ok(status.expiredLeases.length >= 1)
})

test('MVP-5: concurrent block-mode intents cannot both acquire the same path', async (t) => {
  const root = await workspace()
  t.after(() => cleanup(root))
  const ledger = new TripwireLedger({ root, now: () => 5_500_000 })
  await ledger.open()
  const alpha = await register(ledger, 'sess-alpha', 1111)
  const beta = await register(ledger, 'sess-beta', 2222)
  const file = path.join(root, 'race.txt')
  await fs.writeFile(file, 'race\n')

  const [first, second] = await Promise.all([
    ledger.beginWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, tool: 'write', mode: 'block' }),
    ledger.beginWrite({ writerId: beta, sessionId: 'sess-beta', absPath: file, tool: 'write', mode: 'block' }),
  ])
  assert.deepEqual([first.action, second.action].sort(), ['allow', 'block'])
  const status = await ledger.status()
  assert.equal(status.leases.length, 1)
  assert.equal(status.conflicts.length, 1)
})

test('MVP-5: a slow writer may renew after its own lease expires when no newer fence exists', async (t) => {
  const root = await workspace()
  t.after(() => cleanup(root))
  let clock = 5_550_000
  const ledger = new TripwireLedger({ root, now: () => clock, ttlMs: 1_000 })
  await ledger.open()
  const alpha = await register(ledger, 'sess-alpha', 1111)
  const file = path.join(root, 'slow.txt')
  await fs.writeFile(file, 'slow\n')
  const first = await ledger.beginWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, tool: 'write' })
  clock += 5_000
  const slow = await ledger.recordWrite({
    writerId: alpha,
    sessionId: 'sess-alpha',
    absPath: file,
    fence: first.lease.fence,
    beforeHash: first.beforeHash,
  })
  assert.equal(slow.stale, false)
  assert.equal(slow.write.fence, 2)
})

test('MVP-5: a released claim still fences out an old writer', async (t) => {
  const root = await workspace()
  t.after(() => cleanup(root))
  const ledger = new TripwireLedger({ root, now: () => 5_600_000 })
  await ledger.open()
  const alpha = await register(ledger, 'sess-alpha', 1111)
  const beta = await register(ledger, 'sess-beta', 2222)
  const file = path.join(root, 'released.txt')
  await fs.writeFile(file, 'alpha\n')
  const first = await ledger.beginWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, tool: 'write' })
  await ledger.recordWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, fence: first.lease.fence, beforeHash: first.beforeHash })

  const claim = await ledger.claim({ writerId: beta, sessionId: 'sess-beta', absPath: file, reason: 'test' })
  assert.equal(claim.fence, 2)
  await ledger.release({ writerId: beta, absPath: file })

  const late = await ledger.recordWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, fence: first.lease.fence, beforeHash: first.beforeHash })
  assert.equal(late.stale, true)
  const lateOwner = await ledger.recordWrite({ writerId: beta, sessionId: 'sess-beta', absPath: file, fence: claim.fence, beforeHash: first.beforeHash })
  assert.equal(lateOwner.stale, true)
  assert.equal((await ledger.status()).writes[0].fence, 1)
})

test('MVP-1: journal replay restores leases and advances the fence counter', async (t) => {
  const root = await workspace()
  t.after(() => cleanup(root))
  const ledger = new TripwireLedger({ root, now: () => 5_700_000 })
  await ledger.open()
  const alpha = await register(ledger, 'sess-alpha', 1111)
  const beta = await register(ledger, 'sess-beta', 2222)
  const file = path.join(root, 'replay.txt')
  await fs.writeFile(file, 'replay\n')
  const first = await ledger.beginWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, tool: 'write' })
  await ledger.recordWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, fence: first.lease.fence, beforeHash: first.beforeHash })
  await ledger.ignore('custom/**')
  await fs.rm(path.join(root, '.dsh', 'tripwire', 'state.json'))

  const reopened = new TripwireLedger({ root, now: () => 5_700_100 })
  await reopened.open()
  const claim = await reopened.claim({ writerId: beta, sessionId: 'sess-beta', absPath: file, reason: 'replay' })
  assert.equal(claim.fence, 2)
  const status = await reopened.status()
  assert.equal(status.leases[0].owner, beta)
  assert.equal(status.writes[0].path, 'replay.txt')
  assert.ok(status.ignore.some(entry => entry.pattern === 'custom/**'))
  assert.ok(status.ignore.some(entry => entry.pattern === '**/node_modules/**'))
})

test('MVP-6 inputs: ignore list, kill switch, and outside-workspace paths are handled', async (t) => {
  const root = await workspace()
  t.after(() => cleanup(root))
  let clock = 6_000_000
  const ledger = new TripwireLedger({ root, now: () => clock })
  await ledger.open()
  const alpha = await register(ledger, 'sess-alpha', 1111)
  const beta = await register(ledger, 'sess-beta', 2222)
  const ignored = path.join(root, 'node_modules', 'pkg', 'index.js')
  await fs.mkdir(path.dirname(ignored), { recursive: true })
  await fs.writeFile(ignored, 'module.exports = 1\n')

  const held = await ledger.beginWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: ignored, tool: 'write' })
  assert.equal(held.ignored, true)
  const stillFree = await ledger.beginWrite({ writerId: beta, sessionId: 'sess-beta', absPath: ignored, tool: 'write', mode: 'block' })
  assert.equal(stillFree.ignored, true)

  const nestedIgnored = path.join(root, 'packages', 'a', 'node_modules', 'pkg', 'index.js')
  await fs.mkdir(path.dirname(nestedIgnored), { recursive: true })
  await fs.writeFile(nestedIgnored, 'module.exports = 2\n')
  assert.equal((await ledger.beginWrite({ writerId: beta, sessionId: 'sess-beta', absPath: nestedIgnored, tool: 'write', mode: 'block' })).ignored, true)

  const outside = path.join(os.tmpdir(), 'tripwire-outside.txt')
  const outsideResult = await ledger.beginWrite({ writerId: beta, sessionId: 'sess-beta', absPath: outside, tool: 'write', mode: 'block' })
  assert.equal(outsideResult.outside, true)

  await ledger.setKillSwitch(true)
  const bypassed = await ledger.beginWrite({ writerId: beta, sessionId: 'sess-beta', absPath: path.join(root, 'bypass.txt'), tool: 'write', mode: 'block' })
  assert.equal(bypassed.action, 'allow')
  assert.equal(bypassed.bypass, 'kill-switch')

  await ledger.setKillSwitch(false)
  await ledger.ignore('generated/**')
  assert.ok((await ledger.status()).ignore.some(entry => entry.pattern === 'generated/**'))
  await ledger.unignore('generated/**')
  assert.ok(!(await ledger.status()).ignore.some(entry => entry.pattern === 'generated/**'))
  await ledger.setMode('warn')
  assert.equal((await ledger.status()).mode, 'warn')
  assert.equal(clock, 6_000_000)
})

test('MVP-6: the board renders holders, hashes, ignore list, and the kill switch', async (t) => {
  const root = await workspace()
  t.after(() => cleanup(root))
  const now = 7_000_000
  const ledger = new TripwireLedger({ root, now: () => now, ttlMs: 60_000 })
  await ledger.open()
  const alpha = await register(ledger, 'sess-alpha', 1111)
  const file = path.join(root, 'board.txt')
  await fs.writeFile(file, 'board content\n')
  const intent = await ledger.beginWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, tool: 'write' })
  await ledger.recordWrite({ writerId: alpha, sessionId: 'sess-alpha', absPath: file, fence: intent.lease.fence, beforeHash: intent.beforeHash })
  await ledger.setMode('warn')
  await ledger.ignore('tmp/**')

  const html = renderBoard(await ledger.status(), { now })
  assert.match(html, /Session <span>Tripwire<\/span>/u)
  assert.match(html, /board\.txt/u)
  assert.match(html, /sess-alpha/u)
  assert.match(html, /mode <strong>warn<\/strong>/u)
  assert.match(html, /kill switch <strong>OFF<\/strong>/u)
  assert.match(html, /tmp\/\*\*/u)
  assert.match(html, /data-tripwire-action="kill"/u)
  assert.match(html, /Turn kill switch on/u)
})

test('normalizePath is workspace-relative, case-folded on Windows, and rejects escapes', () => {
  const root = path.resolve('C:/workspace')
  const inside = normalizePath(root, 'C:/workspace/Src/App.js', 'win32')
  assert.deepEqual(inside, { key: 'src/app.js', display: 'Src/App.js', absPath: path.resolve('C:/workspace/Src/App.js') })
  assert.equal(normalizePath(root, 'C:/other/App.js', 'win32'), null)
  assert.equal(normalizePath(root, path.join(root, '..', 'escape.js'), 'win32'), null)
  assert.equal(normalizePath(root, path.join(root, '..notes'), 'win32').key, '..notes')
})

test('ignore globs match basenames at any depth and keep directory boundaries', () => {
  assert.equal(globToRegExp('*.lock').test('sub/dir/pnpm.lock'), true)
  assert.equal(globToRegExp('*.lock').test('sub/dir/pnpm.lock.txt'), false)
  assert.equal(globToRegExp('node_modules/**').test('node_modules/a/b.js'), true)
  assert.equal(globToRegExp('src/*.js').test('src/a/b.js'), false)
  assert.equal(globToRegExp('**/*.md').test('README.md'), true)
})
