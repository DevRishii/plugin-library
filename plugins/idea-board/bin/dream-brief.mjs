#!/usr/bin/env node
/**
 * Headless build-packet renderer for the Dream Board.
 *
 * The running app owns dream writes, but the storage file is a plain JSON
 * document, so a packet can be rendered from a terminal without booting the
 * UI. This is the closest supported surface to `dsh dream brief`: the DSH
 * launcher does not let profile plugins add `dsh` subcommands.
 *
 * Usage:
 *   node idea-board/bin/dream-brief.mjs <dream-id> [options]
 *   node idea-board/bin/dream-brief.mjs --list [--storage <file>]
 *
 * Options:
 *   --cwd <dir>       project directory to scan and write into (default: cwd)
 *   --out <dir>       output directory relative to the project (default: briefs)
 *   --storage <file>  Dream Board storage JSON (default: $DSH_HOME/storages)
 *   --template <file> template relative to the project (default: briefs/template.md)
 *   --json            print the result summary as JSON
 *   --help            show this text
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeBrief } from '../brief.js'

/** Print the usage text. */
function usage() {
  return [
    'Usage:',
    '  node idea-board/bin/dream-brief.mjs <dream-id> [--cwd <dir>] [--out <dir>]',
    '  node idea-board/bin/dream-brief.mjs --list [--storage <file>]',
    '',
    'Options: --cwd, --out, --storage, --template, --json, --help',
  ].join('\n')
}

/**
 * Parse the small argument surface by hand; no dependency and no surprises.
 * @param argv - process arguments after the script.
 * @returns parsed options.
 */
function parseArgs(argv) {
  const options = { id: null, list: false, json: false, cwd: process.cwd(), outDir: 'briefs', storage: null, template: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') { options.help = true; continue }
    if (token === '--list') { options.list = true; continue }
    if (token === '--json') { options.json = true; continue }
    if (token === '--cwd' || token === '--out' || token === '--storage' || token === '--template') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${token} needs a value`)
      index += 1
      if (token === '--cwd') options.cwd = value
      if (token === '--out') options.outDir = value
      if (token === '--storage') options.storage = value
      if (token === '--template') options.template = value
      continue
    }
    if (token.startsWith('--cwd=')) { options.cwd = token.slice(6); continue }
    if (token.startsWith('--out=')) { options.outDir = token.slice(6); continue }
    if (token.startsWith('--storage=')) { options.storage = token.slice(10); continue }
    if (token.startsWith('--template=')) { options.template = token.slice(11); continue }
    if (token.startsWith('--')) throw new Error(`unknown option: ${token}`)
    if (options.id !== null) throw new Error(`unexpected argument: ${token}`)
    options.id = token
  }
  return options
}

/** Resolve the Dream Board storage file. */
function storageFile(override) {
  if (override !== null) return path.resolve(override)
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'dream_board.json')
}

/** Read the dream table from the storage document. */
async function readDreams(file) {
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    throw new Error(`Dream Board storage not found: ${file}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Dream Board storage is not valid JSON: ${file}`)
  }
  const table = parsed?.tables?.dreams
  if (table === null || typeof table !== 'object') return []
  return Object.values(table).filter((dream) => dream !== null && typeof dream === 'object' && typeof dream.id === 'string')
}

/** Print active dreams with their ids. */
function listDreams(dreams) {
  if (dreams.length === 0) return 'The Dream Board is empty.'
  const sorted = [...dreams].sort((a, b) => (b.totalScore ?? 0) - (a.totalScore ?? 0) || String(a.title).localeCompare(String(b.title)))
  return sorted.map((dream) => `${dream.id} — ${dream.title} (${dream.totalScore ?? 0}/25, ${dream.status ?? 'unknown'})`).join('\n')
}

/** Run the CLI. */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const file = storageFile(options.storage)
  const dreams = await readDreams(file)
  if (options.list) {
    process.stdout.write(`${listDreams(dreams)}\n`)
    return
  }
  if (options.id === null) throw new Error(`a dream id is required\n\n${usage()}`)
  const dream = dreams.find((entry) => entry.id === options.id)
  if (dream === undefined) throw new Error(`unknown dream: ${options.id}`)
  const written = await writeBrief({
    dream,
    cwd: path.resolve(options.cwd),
    outDir: options.outDir,
    templatePath: options.template ?? undefined,
  })
  const summary = {
    dreamId: dream.id,
    title: dream.title,
    briefPath: written.briefRelativePath,
    checksPath: written.checksRelativePath,
    templatePath: written.templateRelativePath,
    checkCount: written.checks.length,
    unresolvedSlots: written.unresolvedSlots,
    brief: written.briefPath,
    checks: written.checksPath,
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return
  }
  process.stdout.write([
    `Build packet written for "${dream.title}".`,
    `Packet: ${written.briefRelativePath}`,
    `Checks: ${written.checksRelativePath} (${written.checks.length} check${written.checks.length === 1 ? '' : 's'})`,
    `Template: ${written.templateRelativePath}`,
    written.unresolvedSlots.length === 0 ? '' : `Warning: unknown template slots: ${written.unresolvedSlots.join(', ')}`,
    'To start a Fleet session from the packet, use /dream brief <id> --attach in the app.',
  ].filter((line) => line !== '').join('\n') + '\n')
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
