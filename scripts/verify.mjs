#!/usr/bin/env node
/**
 * Structural and hygiene checks for this library.
 *
 * Checks that every plugin package is shaped correctly, every declared bundle
 * patch and client entry exists, and the tree carries no secrets, personal
 * absolute paths, or local state.
 *
 * Usage: node scripts/verify.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGINS = join(ROOT, 'plugins')
const errors = []
const warnings = []

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bAIza[0-9A-Za-z\-_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/
]
const PERSONAL_PATH = /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/i

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.dsh') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

const plugins = readdirSync(PLUGINS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()

for (const name of plugins) {
  const dir = join(PLUGINS, name)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    errors.push(`plugins/${name}: missing package.json`)
    continue
  }

  let pkg
  try {
    pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    errors.push(`plugins/${name}: invalid package.json (${error.message})`)
    continue
  }

  if (!pkg.name) errors.push(`plugins/${name}: package.json has no name`)
  if (!pkg.version) errors.push(`plugins/${name}: package.json has no version`)

  const patch = pkg.dsh?.bundle?.patch
  if (patch && !existsSync(join(dir, patch))) {
    errors.push(`plugins/${name}: declared bundle patch ${patch} does not exist`)
  }

  const client = pkg.dsh?.client
  if (client) {
    const clientEntry = pkg.exports?.['./client']
    if (!clientEntry) {
      errors.push(`plugins/${name}: declares dsh.client but exports no ./client entry`)
    } else if (!existsSync(join(dir, clientEntry))) {
      errors.push(`plugins/${name}: client entry ${clientEntry} does not exist`)
    }
    if (!Array.isArray(client.inject) || client.inject.length === 0) {
      warnings.push(`plugins/${name}: dsh.client declares no inject services`)
    }
  }
}

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file)
  if (rel.startsWith('scripts' + (process.platform === 'win32' ? '\\' : '/'))) {
    // The verifier itself documents the patterns it looks for.
    continue
  }
  if (statSync(file).size > 5 * 1024 * 1024) {
    warnings.push(`${rel}: larger than 5 MB, skipped content scan`)
    continue
  }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) errors.push(`${rel}: looks like it contains a secret (${pattern})`)
  }
  if (PERSONAL_PATH.test(text)) {
    errors.push(`${rel}: contains an absolute user path; make it configurable before publishing`)
  }
}

const localState = walk(ROOT).filter((f) => /[\\/]\.dsh[\\/]|\.log$|\.bak$/.test(f))
if (localState.length > 0) {
  errors.push(`local state or logs present: ${localState.map((f) => relative(ROOT, f)).join(', ')}`)
}

process.stdout.write(`plugin-library verify: ${plugins.length} plugins, ${walk(ROOT).length} files\n`)
for (const warning of warnings) process.stdout.write(`  warn  ${warning}\n`)
for (const error of errors) process.stdout.write(`  ERROR ${error}\n`)
process.stdout.write(errors.length === 0 ? '\nOK\n' : `\n${errors.length} error(s)\n`)
process.exit(errors.length === 0 ? 0 : 1)
