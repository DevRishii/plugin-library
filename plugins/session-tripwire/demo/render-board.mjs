/**
 * Generate a deterministic board page for documentation and screenshot review.
 *
 *   node demo/render-board.mjs
 *
 * The seeded workspace lives under `demo/.preview` and is recreated on every
 * run. Output: `docs/board.html`.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderBoard } from '../board.js'
import { TripwireLedger } from '../ledger.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '.preview')
const projectRoot = path.dirname(here)
const outputDir = path.join(projectRoot, 'docs')

let clock = Date.UTC(2026, 10, 11, 18, 30, 0)
const now = () => clock
const tick = (milliseconds) => { clock += milliseconds }

await fs.rm(root, { recursive: true, force: true })
await fs.mkdir(path.join(root, 'src'), { recursive: true })
await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'preview-workspace', private: true }, null, 2))
await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export const app = "alpha"\n')
await fs.writeFile(path.join(root, 'src', 'theme.ts'), 'export const theme = "beta"\n')
await fs.writeFile(path.join(root, 'AGENTS.md'), '# Workspace rules\n\n- Keep changes scoped.\n')

const ledger = new TripwireLedger({
  root,
  now,
  ttlMs: 120_000,
  mode: 'warn',
  ignore: ['node_modules/**', 'dist/**', '*.lock', '*.map'],
})
await ledger.open()

const alpha = await ledger.registerWriter({ sessionId: 'sess-8f3a', cwd: root, pid: 4821, label: 'session' })
const beta = await ledger.registerWriter({ sessionId: 'sess-c21d', cwd: root, pid: 5093, label: 'session' })
const gamma = await ledger.registerWriter({ sessionId: 'sess-77e1', cwd: root, pid: 5210, label: 'subagent' })

async function write(writer, relative, content, mode = undefined) {
  const target = path.join(root, relative)
  const intent = await ledger.beginWrite({
    writerId: writer.id,
    sessionId: writer.sessionId,
    absPath: target,
    tool: 'write',
    mode,
  })
  if (intent.action === 'block') return intent
  await fs.writeFile(target, content)
  await ledger.recordWrite({
    writerId: writer.id,
    sessionId: writer.sessionId,
    absPath: target,
    fence: intent.lease.fence,
    tool: 'write',
    beforeHash: intent.beforeHash,
  })
  return intent
}

await write(alpha, 'src/app.ts', 'export const app = "alpha v2"\n')
tick(8_000)
await write(alpha, 'AGENTS.md', '# Workspace rules\n\n- Keep changes scoped.\n- Run the checks file.\n')
tick(6_000)
await write(beta, 'src/theme.ts', 'export const theme = "beta v2"\n')
tick(5_000)

// A warned overlap: beta overwrites app.ts and the conflict is recorded.
await write(beta, 'src/app.ts', 'export const app = "beta handoff"\n', 'warn')
tick(2_000)

// A blocked overlap: gamma tries AGENTS.md and is refused.
await ledger.beginWrite({
  writerId: gamma.id,
  sessionId: gamma.sessionId,
  absPath: path.join(root, 'AGENTS.md'),
  tool: 'str_replace_editor',
  mode: 'block',
})
tick(1_000)

const status = await ledger.status()
await fs.mkdir(outputDir, { recursive: true })
const html = renderBoard(status, { now: now() })
await fs.writeFile(path.join(outputDir, 'board.html'), html)
console.log(`board: ${path.join(outputDir, 'board.html')}`)
console.log(`leases: ${status.stats.activeLeases}, writes: ${status.stats.writes}, conflicts: ${status.stats.conflicts}`)
