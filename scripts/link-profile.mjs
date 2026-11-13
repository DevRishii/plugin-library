#!/usr/bin/env node
/**
 * Point a DeepSeek Harness profile at this library.
 *
 * Adds every plugin package as an `@local/*` link dependency, appends the
 * packages that declare a bundle patch to `dsh.profile.bundles`, and replaces
 * the matching `node_modules/@local/*` junctions so the app resolves the new
 * path immediately. The profile's package.json is backed up first.
 *
 * Usage:
 *   node scripts/link-profile.mjs [--profile <name|path>] [--dry-run]
 *
 * The default profile is $DSH_PROFILE, else "desktop".
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGINS = join(ROOT, 'plugins')

// Bundle order matters: later patches can override earlier rows. This mirrors
// the order the desktop profile has used, with dsh-doctor (CLI-only) omitted.
const BUNDLE_ORDER = [
  'theme-engine',
  'turn-cost',
  'fleet-preset',
  'fleet-view',
  'idea-board',
  'session-tripwire',
  'session-diff',
  'restart-app'
]

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const flagIndex = argv.indexOf('--profile')
const profileArg = flagIndex >= 0 ? argv[flagIndex + 1] : undefined
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileName = process.env.DSH_PROFILE || 'desktop'
const profileDir = profileArg
  ? (profileArg.includes('/') || profileArg.includes('\\') ? resolve(profileArg) : join(dshHome, 'profiles', profileArg))
  : join(dshHome, 'profiles', profileName)

const packages = new Map()
for (const name of readdirSync(PLUGINS)) {
  const dir = join(PLUGINS, name)
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) continue
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  packages.set(name, {
    name,
    dir,
    pkg,
    bundle: pkg.dsh?.bundle?.patch ? true : false
  })
}

if (packages.size === 0) {
  console.error(`No plugin packages found under ${PLUGINS}`)
  process.exit(1)
}

const manifestPath = join(profileDir, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`Profile not found: ${profileDir}`)
  console.error('Pass --profile <name> or set DSH_PROFILE.')
  process.exit(1)
}

const originalText = readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(originalText)
manifest.dependencies ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []

const changes = []
const dependencies = manifest.dependencies
for (const [name, entry] of packages) {
  const spec = `link:${entry.dir.replace(/\\/g, '/')}`
  const current = dependencies[`@local/${name}`]
  if (current !== spec) {
    changes.push({
      kind: 'dependency',
      name: `@local/${name}`,
      from: current ?? '(absent)',
      to: spec
    })
    dependencies[`@local/${name}`] = spec
  }
}

// Keep existing bundle order, drop managed bundles that no longer exist, then
// append the missing ones in canonical order.
const bundles = manifest.dsh.profile.bundles
const managed = new Set([...packages.values()].filter((p) => p.bundle).map((p) => `@local/${p.name}`))
const known = new Set(BUNDLE_ORDER.map((name) => `@local/${name}`))
// Prune only library-owned entries that no longer exist; leave unrelated
// @local bundles (other plugins the profile may use) untouched.
const nextBundles = bundles.filter(
  (entry) => !entry.startsWith('@local/') || managed.has(entry) || !known.has(entry)
)

for (const name of BUNDLE_ORDER) {
  const id = `@local/${name}`
  if (!packages.get(name)?.bundle) continue
  if (!nextBundles.includes(id)) {
    nextBundles.push(id)
    changes.push({ kind: 'bundle-added', name: id })
  }
}
for (const entry of bundles) {
  if (entry.startsWith('@local/') && !managed.has(entry) && known.has(entry)) {
    changes.push({ kind: 'bundle-pruned', name: entry })
  }
}
if (JSON.stringify(nextBundles) !== JSON.stringify(bundles)) {
  manifest.dsh.profile.bundles = nextBundles
}

const nextText = `${JSON.stringify(manifest, null, 2)}\n`
const manifestChanged = nextText !== originalText

// node_modules/@local junction per package.
const scope = join(profileDir, 'node_modules', '@local')
const links = []
for (const entry of packages.values()) {
  const dest = join(scope, entry.name)
  let state = 'missing'
  if (existsSync(dest)) {
    const stat = lstatSync(dest)
    if (!stat.isSymbolicLink()) {
      links.push({ name: entry.name, state: 'skipped-real-directory' })
      continue
    }
    const target = realpathSync(dest)
    const wanted = realpathSync(entry.dir)
    state = target.toLowerCase() === wanted.toLowerCase() ? 'unchanged' : 'stale'
  }
  if (state === 'stale' || state === 'missing') {
    if (!dryRun) {
      mkdirSync(scope, { recursive: true })
      if (state === 'stale') rmdirSync(dest)
      symlinkSync(entry.dir, dest, 'junction')
    }
    links.push({ name: entry.name, state: state === 'stale' ? 'replaced' : 'created' })
  } else {
    links.push({ name: entry.name, state })
  }
}

process.stdout.write(`Profile: ${profileDir}\n`)
process.stdout.write(`Mode:    ${dryRun ? 'dry run' : 'apply'}\n\n`)

if (changes.length === 0 && links.every((l) => l.state === 'unchanged' || l.state === 'skipped-real-directory')) {
  process.stdout.write('Already linked; nothing to do.\n')
  process.exit(0)
}

for (const change of changes) {
  if (change.kind === 'dependency') {
    process.stdout.write(`  dependency  ${change.name}\n    ${change.from}\n    -> ${change.to}\n`)
  } else if (change.kind === 'bundle-pruned') {
    process.stdout.write(`  bundle      remove ${change.name} (package no longer in plugins/)\n`)
  } else if (change.kind === 'bundle-added') {
    process.stdout.write(`  bundle      add ${change.name}\n`)
  }
}
for (const link of links) {
  if (link.state !== 'unchanged') process.stdout.write(`  junction    ${link.name}: ${link.state}\n`)
}

if (!dryRun && manifestChanged) {
  const backupDir = join(profileDir, '.plugin-library-backup')
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = join(backupDir, `package.json-${stamp}`)
  copyFileSync(manifestPath, backup)
  writeFileSync(manifestPath, nextText)
  process.stdout.write(`\nWrote ${manifestPath}\nBackup: ${backup}\n`)
}

process.stdout.write('\nRestart the app to load the changes (composer restart button, /restart-app, or quit and reopen).\n')
