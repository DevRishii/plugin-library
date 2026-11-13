#!/usr/bin/env node
/**
 * Run every plugin's own test suite, sequentially, and summarize.
 *
 * Plugins without a `test` script are reported as skipped rather than failed.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGINS = join(ROOT, 'plugins')

const results = []
for (const name of readdirSync(PLUGINS).sort()) {
  const dir = join(PLUGINS, name)
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) continue

  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  if (!pkg.scripts?.test) {
    results.push({ name, status: 'skip' })
    continue
  }

  process.stdout.write(`\n=== ${name}@${pkg.version ?? '?'}\n`)
  const run = spawnSync('npm test', {
    cwd: dir,
    shell: true,
    stdio: 'inherit',
    env: process.env
  })
  results.push({ name, status: run.status === 0 ? 'pass' : 'fail' })
}

const failed = results.filter((r) => r.status === 'fail')
const passed = results.filter((r) => r.status === 'pass')
const skipped = results.filter((r) => r.status === 'skip')

process.stdout.write('\n=== Summary\n')
for (const r of results) process.stdout.write(`  ${r.status.padEnd(5)} ${r.name}\n`)
process.stdout.write(`\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped\n`)

process.exit(failed.length === 0 ? 0 : 1)
