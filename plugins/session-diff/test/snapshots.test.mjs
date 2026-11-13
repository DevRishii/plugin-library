import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { SnapshotStore, earliestCapture } from '../src/snapshots.mjs'
import { sha256 } from '../src/paths.mjs'
import { tempDir } from './helpers.mjs'
import { writeFileSync } from 'node:fs'

test('capture stores one object per path and content-addresses it', async () => {
  const dir = tempDir()
  const file = join(dir, 'note.txt')
  writeFileSync(file, 'before')
  const store = new SnapshotStore({ dir })
  const first = await store.capture({ absolute: file, path: 'note.txt', turn: 1 })
  assert.equal(first.hash, sha256('before'))
  const second = await store.capture({ absolute: file, path: 'note.txt', turn: 2 })
  assert.equal(second, null)
  assert.equal(store.stats().entries, 1)
  assert.equal(store.stats().bytes, 6)
  assert.equal(store.before('note.txt').hash, sha256('before'))
  assert.deepEqual(store.paths(), [{ path: 'note.txt', captures: 1, bytes: 6 }])
})

test('restore refuses drift unless forced, then rewrites the file', async () => {
  const dir = tempDir()
  const file = join(dir, 'note.txt')
  writeFileSync(file, 'before')
  const store = new SnapshotStore({ dir })
  await store.capture({ absolute: file, path: 'note.txt', turn: 1 })
  writeFileSync(file, 'after')
  const refused = await store.restore({ path: 'note.txt', absolute: file, expectedAfterHash: sha256('expected-other') })
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /refusing to overwrite/)
  const forced = await store.restore({ path: 'note.txt', absolute: file, expectedAfterHash: sha256('expected-other'), force: true })
  assert.equal(forced.ok, true)
  assert.equal(forced.restoredHash, sha256('before'))
  assert.equal(store.object(store.before('note.txt').hash).toString('utf8'), 'before')
})

test('gc drops entries past the retention window and unreferenced objects', async () => {
  const dir = tempDir()
  const file = join(dir, 'note.txt')
  writeFileSync(file, 'before')
  let now = Date.UTC(2026, 10, 1)
  const store = new SnapshotStore({ dir, retentionDays: 7, now: () => now })
  await store.capture({ absolute: file, path: 'note.txt', turn: 1 })
  now += 8 * 24 * 60 * 60 * 1000
  const collected = await store.gc()
  assert.equal(collected.removedEntries, 1)
  assert.equal(collected.removedObjects, 1)
  assert.equal(store.stats().entries, 0)
})

test('gc enforces the byte cap from oldest captures', async () => {
  const dir = tempDir()
  const first = join(dir, 'a.txt')
  const second = join(dir, 'b.txt')
  writeFileSync(first, 'aaaa')
  writeFileSync(second, 'bbbb')
  let now = 1_000
  const store = new SnapshotStore({ dir, maxBytes: 4, now: () => now })
  await store.capture({ absolute: first, path: 'a.txt', turn: 1 })
  now += 1_000
  await store.capture({ absolute: second, path: 'b.txt', turn: 2 })
  const stats = store.stats()
  assert.equal(stats.bytes, 4)
  assert.equal(stats.entries, 1)
  assert.equal(stats.paths, 1)
})

test('capture skips files beyond the per-file cap', async () => {
  const dir = tempDir()
  const file = join(dir, 'big.bin')
  writeFileSync(file, Buffer.alloc(10))
  const store = new SnapshotStore({ dir, maxFileBytes: 4 })
  assert.equal(await store.capture({ absolute: file, path: 'big.bin', turn: 1 }), null)
  assert.equal(store.stats().entries, 0)
})

test('earliestCapture picks the first entry for a path', () => {
  const entries = [
    { path: 'a', capturedAt: 20 },
    { path: 'a', capturedAt: 10 },
    { path: 'b', capturedAt: 5 },
  ]
  assert.equal(earliestCapture(entries, 'a').capturedAt, 10)
  assert.equal(earliestCapture(entries, 'c'), undefined)
})
