/**
 * Build packets: deterministic, reviewable markdown rendered from one Dream
 * Board dream, an editable template, and a bounded repository scan.
 *
 * There is no model call and no network access in this module. The same dream,
 * template, and repository produce the same packet, so a regenerated packet is
 * diffable and a reviewer can see exactly what changed. The companion
 * `<slug>.checks.json` holds one pass/fail check per MVP bullet; regeneration
 * keeps the status and evidence recorded against an unchanged check.
 *
 * Nothing here touches the Dream Board store; the caller supplies a normalized
 * dream and a project directory.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const MAX_TOP_LEVEL = 40
const MAX_SCAN_FILES = 1500
const MAX_MANIFESTS = 12
const MAX_COMMANDS = 10
const MAX_TEST_FILES = 12
const MAX_README_BYTES = 4096
const SLUG_MAX = 60
const MAX_FIELD = 20000

/** Windows device names that cannot be used as a file stem. */
const RESERVED_STEMS = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

/** Directories that never belong in a build-packet scan. */
const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', '.cache', '.next', '.nuxt', '.output', '.turbo', '.venv',
  'node_modules', 'bower_components', '__pycache__', 'venv', 'env', 'dist', 'build',
  'out', 'coverage', 'target', 'vendor', '.idea', '.vscode',
])

/** Manifest file names recognized by the scan. */
const MANIFEST_NAMES = [
  'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json',
]

/** Package-manager lock files, in detection order. */
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

/** Test-file patterns the scan recognizes. */
const TEST_PATTERNS = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(^|[._-])test\.(go|py|rs)$/i,
  /^test_.*\.py$/i,
  /Tests?\.(cs|java|kt)$/,
]

/** Default editable template seeded into `briefs/template.md` on first use. */
export const DEFAULT_TEMPLATE = `<!--
  Build packet template. A slot is a name in double braces; edits affect future
  packets only and never change an already-written packet.

  Slots: title, pitch, type, score, dreamId, iteration, objective, targetUser,
  nonGoals, mvpScope, acceptanceTests, fileMap, verification, reviewChecklist,
  problem, value, monetization, architecture, competitors, sources, effort,
  briefPath, checksPath, templatePath.

  Unknown slots stay visible in the output and /dream brief lists them, so a
  typo does not vanish silently.
-->
# Build packet: {{title}}

> {{pitch}}
>
> {{type}} · {{score}} · dream \`{{dreamId}}\` iteration {{iteration}}

## Start here

- Confirm the target project from the file map before editing.
- Plan the smallest end-to-end slice and name how each acceptance check will be
  demonstrated.
- Update only \`{{checksPath}}\` with pass/fail and evidence. Do not edit this
  packet; regenerate it with \`/dream brief {{dreamId}}\` after the dream or
  template changes.
- Template: \`{{templatePath}}\`. Edits affect future packets only.

## Objective

{{objective}}

## Target user

{{targetUser}}

## Non-goals

{{nonGoals}}

## MVP scope

{{mvpScope}}

## Acceptance tests

One check per MVP bullet. The authoritative pass/fail state and evidence live
in \`{{checksPath}}\`; replace an Expected line with the exact case and result
before the build, then record the evidence.

{{acceptanceTests}}

## File map

{{fileMap}}

## Verification commands

These are the commands the scan found. Run each in the directory named beside
it; when the target project differs, use that project's own test and lint
commands and record them here.

{{verification}}

## Human review checklist

{{reviewChecklist}}

## Dream context

### Problem

{{problem}}

### Why it is valuable

{{value}}

### Monetization

{{monetization}}

### Architecture

{{architecture}}

### Competitive notes

{{competitors}}

### Sources

{{sources}}

### Effort

{{effort}}

## Build instructions

- Build the smallest end-to-end slice that satisfies the MVP scope and passes
  every acceptance check.
- Work inside the file map. List any file you add outside it in the final report.
- Do not expand beyond the MVP scope. Put follow-ups under "Follow-ups" in the
  final report instead of building them.
- Update \`{{checksPath}}\`: set each check to \`pass\` or \`fail\` with a one-line
  evidence note. Do not leave a check \`pending\` when claiming completion.
- Report the exact verification commands you ran and their output.
`

/**
 * Turn a dream title into a stable file name.
 * @param value - any title.
 * @returns lowercase ASCII slug, never empty.
 */
export function slugify(value) {
  const base = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '')
  if (base === '') return 'dream'
  return RESERVED_STEMS.has(base) ? `${base}-dream` : base
}

/**
 * Whether one path is the root or lives inside it.
 * @param root - absolute root directory.
 * @param candidate - absolute candidate path.
 * @returns true when candidate is contained by root.
 */
export function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Render a path with forward slashes for markdown. */
function displayPath(value) {
  return String(value).replaceAll('\\', '/')
}

/** Read a UTF-8 file, or answer undefined when it is absent. */
async function readOptional(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return undefined
    throw error
  }
}

/** Read a JSON file, or answer undefined when absent or malformed. */
async function readJsonOptional(file) {
  const raw = await readOptional(file)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Read one bounded, trimmed string. */
function text(value, max = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** Strip trailing sentence punctuation so a rendered criterion reads cleanly. */
function stripPeriod(value) {
  return value.replace(/[.!?]+$/u, '').trim()
}

/**
 * Whether a path stays inside a real (link-resolved) root. A path that does not
 * exist yet is checked through its nearest existing ancestor, so a symlinked
 * output directory cannot redirect packet writes outside the project.
 * @param realRoot - link-resolved project root.
 * @param candidate - absolute path that may not exist yet.
 * @returns true when the resolved path stays inside the root.
 */
async function realContained(realRoot, candidate) {
  let current = candidate
  for (;;) {
    try {
      return isInside(realRoot, await fs.realpath(current))
    } catch (error) {
      if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') return false
      const parent = path.dirname(current)
      if (parent === current) return false
      current = parent
    }
  }
}

/** Read the git branch without spawning a process. */
async function gitInfo(root) {
  try {
    const head = await fs.readFile(path.join(root, '.git', 'HEAD'), 'utf8')
    const match = /^ref: refs\/heads\/(.+)$/m.exec(head.trim())
    return { present: true, branch: match === null ? null : match[1] }
  } catch {
    return { present: false, branch: null }
  }
}

/** Count files in one directory without following links, bounded in time. */
async function countFiles(root) {
  let count = 0
  let capped = false
  async function walk(dir, depth) {
    if (count >= 120 || capped) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (count >= 120) {
        capped = true
        return
      }
      if (entry.isDirectory()) {
        if (depth < 2 && !IGNORED_DIRS.has(entry.name)) await walk(path.join(dir, entry.name), depth + 1)
      } else if (entry.isFile()) {
        count += 1
      }
    }
  }
  await walk(root, 0)
  return { files: count, capped }
}

/** Detect the package manager used in one directory. */
async function packageManagerFor(dir, packageJson) {
  if (packageJson !== undefined && typeof packageJson.packageManager === 'string' && packageJson.packageManager !== '') {
    return packageJson.packageManager.split('@')[0]
  }
  for (const [file, manager] of LOCKFILES) {
    try {
      await fs.access(path.join(dir, file))
      return manager
    } catch {
      // keep checking
    }
  }
  return 'npm'
}

/** Describe one package.json manifest. */
async function packageManifest(file) {
  const raw = await readOptional(file)
  if (raw === undefined) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { path: file, kind: 'package.json', name: '', version: '', scripts: {}, dir: path.dirname(file), runner: 'npm', dependencies: [] }
  }
  const scripts = {}
  if (parsed.scripts !== null && typeof parsed.scripts === 'object') {
    for (const [name, command] of Object.entries(parsed.scripts).slice(0, 20)) {
      if (typeof command === 'string') scripts[name] = command.slice(0, 300)
    }
  }
  const dependencies = []
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const block = parsed[key]
    if (block === null || typeof block !== 'object') continue
    for (const name of Object.keys(block)) {
      if (!dependencies.includes(name)) dependencies.push(name)
      if (dependencies.length >= 40) break
    }
  }
  return {
    path: file,
    kind: 'package.json',
    name: text(parsed.name, 200),
    version: text(parsed.version, 100),
    scripts,
    dir: path.dirname(file),
    runner: await packageManagerFor(path.dirname(file), parsed),
    dependencies,
  }
}

/** Describe one non-Node manifest by name only. */
async function plainManifest(file, kind) {
  const raw = await readOptional(file)
  if (raw === undefined) return null
  let name = ''
  if (kind === 'pyproject.toml') {
    const match = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(raw)
    if (match !== null) name = match[1]
  } else if (kind === 'Cargo.toml') {
    const match = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(raw)
    if (match !== null) name = match[1]
  } else if (kind === 'go.mod') {
    const match = /^module\s+(\S+)/m.exec(raw)
    if (match !== null) name = match[1]
  }
  return { path: file, kind, name: text(name, 200), version: '', scripts: {}, dir: path.dirname(file), runner: '', dependencies: [] }
}

/** Detect the language stack from manifests and a few root files. */
async function detectStacks(root, manifests) {
  const stacks = []
  const add = (value) => { if (!stacks.includes(value)) stacks.push(value) }
  const hasFile = async (name) => {
    try {
      await fs.access(path.join(root, name))
      return true
    } catch {
      return false
    }
  }
  for (const manifest of manifests) {
    if (manifest.kind === 'package.json') {
      add('Node.js')
      const deps = new Set(manifest.dependencies)
      if (deps.has('typescript') || await hasFile('tsconfig.json')) add('TypeScript')
      if (deps.has('react')) add('React')
      if (deps.has('next')) add('Next.js')
      if (deps.has('electron')) add('Electron')
      if (deps.has('vue')) add('Vue')
      if (deps.has('svelte')) add('Svelte')
      if (deps.has('vite')) add('Vite')
    } else if (manifest.kind === 'pyproject.toml' || manifest.kind === 'requirements.txt') {
      add('Python')
    } else if (manifest.kind === 'Cargo.toml') {
      add('Rust')
    } else if (manifest.kind === 'go.mod') {
      add('Go')
    } else if (manifest.kind === 'pom.xml' || manifest.kind === 'build.gradle' || manifest.kind === 'build.gradle.kts') {
      add('Java')
    } else if (manifest.kind === 'Gemfile') {
      add('Ruby')
    } else if (manifest.kind === 'composer.json') {
      add('PHP')
    }
  }
  if (stacks.length === 0) add('Unknown')
  return stacks
}

/** Build the command list a new build should run. */
function commandsFor(root, manifests) {
  const commands = []
  const seen = new Set()
  const push = (entry) => {
    const key = `${entry.dir ?? ''}|${entry.command}`
    if (seen.has(key) || commands.length >= MAX_COMMANDS) return
    seen.add(key)
    commands.push(entry)
  }
  for (const manifest of manifests.slice(0, MAX_MANIFESTS)) {
    if (manifest.kind !== 'package.json') continue
    for (const name of ['test', 'lint', 'typecheck', 'check', 'build', 'dev']) {
      if (typeof manifest.scripts[name] !== 'string' || manifest.scripts[name] === '') continue
      const relative = path.relative(root, manifest.dir)
      push({
        label: `package script "${name}"`,
        command: `${manifest.runner} run ${name}`,
        dir: relative === '' ? null : displayPath(relative),
        source: displayPath(path.relative(root, manifest.path)),
      })
    }
  }
  if (!commands.some((entry) => entry.command.includes('test'))) {
    const kinds = new Set(manifests.map((manifest) => manifest.kind))
    if (kinds.has('Cargo.toml')) push({ label: 'Rust tests', command: 'cargo test', dir: null, source: 'Cargo.toml' })
    if (kinds.has('go.mod')) push({ label: 'Go tests', command: 'go test ./...', dir: null, source: 'go.mod' })
    if (kinds.has('pom.xml') || kinds.has('build.gradle') || kinds.has('build.gradle.kts')) {
      push({ label: 'JVM tests', command: 'mvn test', dir: null, source: 'Maven/Gradle manifest' })
    }
    if (kinds.has('pyproject.toml') || kinds.has('requirements.txt')) {
      push({ label: 'Python tests', command: 'pytest -q', dir: null, source: 'Python manifest' })
    }
  }
  return commands
}

/** Whether a file name looks like a test. */
function isTestFile(name) {
  return TEST_PATTERNS.some((pattern) => pattern.test(name))
}

/** Find a bounded sample of existing test files. */
async function findTests(root, excluded = new Set()) {
  const files = []
  let count = 0
  let visited = 0
  async function walk(dir, depth, prefix) {
    if (depth > 3 || visited >= MAX_SCAN_FILES) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (visited >= MAX_SCAN_FILES) return
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
      if (entry.isDirectory() && excluded.has(path.join(dir, entry.name))) continue
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), depth + 1, relative)
        continue
      }
      visited += 1
      if (!entry.isFile() || !isTestFile(entry.name)) continue
      count += 1
      if (files.length < MAX_TEST_FILES) files.push(relative)
    }
  }
  await walk(root, 0, '')
  return { count, files }
}

/** Read the first heading of a README when one exists. */
async function readDoc(root, name) {
  try {
    const raw = await fs.readFile(path.join(root, name), 'utf8')
    const first = raw.slice(0, MAX_README_BYTES).split(/\r?\n/u).find((line) => /^#\s+/.test(line))
    return { path: name, title: first === undefined ? '' : text(first.replace(/^#\s+/, ''), 160) }
  } catch {
    return null
  }
}

/**
 * Scan a project directory into the facts a build packet needs: top-level
 * layout, manifests, verification commands, existing tests, docs, and git
 * state. The scan is bounded and never writes.
 * @param cwd - project directory to scan.
 * @returns the scan result.
 */
export async function scanRepo(cwd, options = {}) {
  const root = path.resolve(cwd)
  const excluded = new Set((Array.isArray(options.exclude) ? options.exclude : []).map((entry) => path.resolve(entry)))
  let stat
  try {
    stat = await fs.stat(root)
  } catch {
    throw new Error(`project directory does not exist: ${root}`)
  }
  if (!stat.isDirectory()) throw new Error(`project path is not a directory: ${root}`)

  const scan = {
    root,
    git: await gitInfo(root),
    stacks: [],
    topLevel: [],
    topLevelFiles: [],
    ignored: [],
    manifests: [],
    commands: [],
    tests: { count: 0, files: [] },
    docs: [],
    matches: [],
    warnings: [],
    truncated: false,
  }

  let entries = []
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    throw new Error(`could not read project directory: ${error instanceof Error ? error.message : String(error)}`)
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))

  const manifestCandidates = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excluded.has(path.join(root, entry.name))) continue
      if (IGNORED_DIRS.has(entry.name)) {
        scan.ignored.push(entry.name)
        continue
      }
      if (scan.topLevel.length >= MAX_TOP_LEVEL) continue
      const counted = await countFiles(path.join(root, entry.name))
      if (counted.capped) scan.truncated = true
      scan.topLevel.push({ name: entry.name, files: counted.files, capped: counted.capped })
      for (const name of MANIFEST_NAMES) {
        manifestCandidates.push(path.join(root, entry.name, name))
      }
    } else if (entry.isFile()) {
      if (!entry.name.startsWith('.')) scan.topLevelFiles.push(entry.name)
      if (MANIFEST_NAMES.includes(entry.name)) manifestCandidates.push(path.join(root, entry.name))
    }
  }
  for (const name of MANIFEST_NAMES) manifestCandidates.push(path.join(root, name))

  const seenManifests = new Set()
  for (const file of manifestCandidates) {
    if (scan.manifests.length >= MAX_MANIFESTS) break
    if (seenManifests.has(file)) continue
    seenManifests.add(file)
    let present = false
    try {
      await fs.access(file)
      present = true
    } catch {
      continue
    }
    if (!present) continue
    const kind = path.basename(file)
    const manifest = kind === 'package.json' ? await packageManifest(file) : await plainManifest(file, kind)
    if (manifest !== null) scan.manifests.push(manifest)
  }

  scan.stacks = await detectStacks(root, scan.manifests)
  scan.commands = commandsFor(root, scan.manifests)
  scan.tests = await findTests(root, excluded)
  for (const name of ['README.md', 'readme.md', 'README']) {
    const doc = await readDoc(root, name)
    if (doc !== null) {
      scan.docs.push(doc)
      break
    }
  }

  if (scan.manifests.length === 0) {
    scan.warnings.push('No package manifest was found at the repository root; the file map is based on directory names only.')
  }
  if (scan.tests.count === 0) {
    scan.warnings.push('No test files were found within three levels; the build must add at least one runnable check.')
  }
  if (scan.commands.length === 0) {
    scan.warnings.push('No test, lint, or build command was discovered; record a verification command manually.')
  }
  if (!scan.git.present) {
    scan.warnings.push('The project is not under git; review will not have a diff to inspect.')
  }
  return scan
}

/** Words that carry no project-name signal. */
const NAME_STOP_WORDS = new Set((
  'the and for with that this from into your you they them their are was will can not but all any one two '
  + 'per run runs app apps user users use used using build make new session sessions mode product feature tool '
  + 'system need needs who what when where how why its it is deepseek harness dsh root local plugin plugins '
  + 'tools client server core test tests scripts src packages monorepo workspace'
).split(' '))

/** Normalize free text into concept words for project-name matching. */
function nameWords(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !NAME_STOP_WORDS.has(word))
}

/** Find top-level projects whose names share words with the dream. */
function matchProjects(scan, dream) {
  const wanted = new Set(nameWords([dream.title, dream.pitch, ...(Array.isArray(dream.tags) ? dream.tags : [])].join(' ')))
  const matches = []
  for (const manifest of scan.manifests) {
    const relative = displayPath(path.relative(scan.root, manifest.dir))
    if (relative === '') continue
    if (/(^|[./_-])(backup|old|archive|tmp|temp)([./_-]|$)/i.test(relative)) continue
    const candidate = new Set(nameWords(`${manifest.name} ${relative}`))
    const shared = [...wanted].filter((word) => candidate.has(word))
    if (shared.length === 0) continue
    matches.push({ path: relative, name: manifest.name, shared: shared.slice(0, 4) })
  }
  matches.sort((a, b) => b.shared.length - a.shared.length || a.path.localeCompare(b.path))
  return matches.slice(0, 5)
}

/** Choose a falsifiable expected result for one MVP bullet. */
function expectedFor(requirement) {
  const value = requirement.toLowerCase()
  if (/(refus|den(y|ied)|block|hard stop|stop|prevent|reject)/.test(value)) {
    return 'The action is refused at the stated boundary, and the visible reason names the limit that was hit.'
  }
  if (/(persist|resume|restart|survive|reload)/.test(value)) {
    return 'The value is still present after a restart or resume, unchanged from what was set.'
  }
  if (/(escrow|reserve|pre-spawn|parallel|concurrent)/.test(value)) {
    return 'Concurrent spawns cannot exceed the cap because the parent with insufficient unreserved budget is refused before the spawn starts.'
  }
  if (/(warn|notice|downshift|cheaper|fallback)/.test(value)) {
    return 'The threshold produces the stated visible warning, and the next spawn uses the cheaper tier with the change recorded.'
  }
  if (/(edit|editable|set at|configure|config|toggle)/.test(value)) {
    return 'The value can be set, changed, and read back, and the visible state matches the configured value.'
  }
  if (/(budget|cap|threshold|percent|%|\$|dollar|token|spend|cost)/.test(value)) {
    return 'The accounted or displayed value matches the stated limit or threshold, and the evidence records the input that produced it.'
  }
  if (/(export|pdf|report|document|download)/.test(value)) {
    return 'The generated artifact opens and contains the expected sections, fields, and totals.'
  }
  if (/(import|ingest|parse|upload|csv)/.test(value)) {
    return 'The representative fixture imports without manual edits, and the parsed fields match the fixture.'
  }
  if (/(match|reconcil|exception|queue|diff)/.test(value)) {
    return 'The fixture produces the expected queue or diff, including the named exception case.'
  }
  if (/\b(?:ui|status bar|screen|button|form|dashboard|page|panel|view|label)\b/.test(value)) {
    return 'The screen shows the expected state for a known input, and the evidence is a screenshot or the visible values.'
  }
  return 'The described capability is demonstrated end to end from a clean start, and the evidence names the input and the observed result.'
}

/** Choose the inspection hint for one MVP bullet. */
function checkMethod(requirement) {
  const value = requirement.toLowerCase()
  if (/(import|ingest|upload|parse|csv)/.test(value)) return 'Import a representative fixture and confirm the parsed result.'
  if (/\b(?:pdf|export|report|document|download|file)\b/.test(value)) return 'Generate the artifact and inspect its contents.'
  if (/(escrow|reserve|pre-spawn|parallel|concurrent)/.test(value)) return 'Spawn enough children to cross the cap and confirm the refusal and settlement.'
  if (/(warn|notice|downshift|cheaper|fallback)/.test(value)) return 'Trigger the threshold and inspect the notice and the next spawn model.'
  if (/(hard stop|refus|den(y|ied)|block|prevent)/.test(value)) return 'Drive the session to the boundary and confirm the stop, the reason, and the retained output.'
  if (/(encrypt|store|persist|database|audit|backup|record)/.test(value)) return 'Write and read the data back, then inspect the stored record and audit entry.'
  if (/(edit|editable|set at|configure|config|toggle|budget|cap|threshold)/.test(value)) return 'Set the value, change it, and reopen the view to confirm it persists.'
  if (/(match|reconcil|exception|queue|diff)/.test(value)) return 'Run the flow on fixtures and inspect the resulting queue or diff.'
  if (/\b(?:ui|status bar|screen|button|form|dashboard|page|panel|view|menu|label)\b/.test(value)) return 'Open the screen and confirm the visible state against a known value.'
  if (/(template|mapping|config)/.test(value)) return 'Apply the template to two different inputs and inspect both results.'
  return 'Exercise the capability from a clean start and record where the result is visible.'
}

/**
 * Build one acceptance check per MVP bullet.
 * @param dream - normalized dream.
 * @returns pending checks in MVP order.
 */
export function buildChecks(dream) {
  const bullets = Array.isArray(dream?.mvpScope) ? dream.mvpScope : []
  return bullets.map((bullet, index) => {
    const requirement = text(bullet, 300)
    return {
      id: `MVP-${index + 1}`,
      requirement,
      expected: expectedFor(requirement),
      how: checkMethod(requirement),
      kind: 'manual',
      status: 'pending',
      evidence: '',
    }
  })
}

/**
 * Keep pass/fail state across regeneration when the check did not change.
 * @param previous - prior checks document, a bare array, or undefined.
 * @param next - freshly derived checks.
 * @returns the merged checks.
 */
export function mergeChecks(previous, next) {
  const prior = new Map()
  const list = Array.isArray(previous) ? previous : Array.isArray(previous?.checks) ? previous.checks : []
  for (const check of list) {
    if (check !== null && typeof check === 'object' && typeof check.id === 'string') prior.set(check.id, check)
  }
  return next.map((check) => {
    const before = prior.get(check.id)
    if (before === undefined || before.requirement !== check.requirement) return check
    return {
      ...check,
      status: before.status === 'pass' || before.status === 'fail' ? before.status : 'pending',
      evidence: typeof before.evidence === 'string' ? before.evidence.slice(0, 1000) : '',
    }
  })
}

/** The standing review checklist. */
export function reviewChecklist() {
  return [
    'Every acceptance check is `pass` or `fail` with a one-line evidence note, not left `pending`.',
    'The recorded verification commands were run from the current project state, or from a clean checkout when the project is under git, and their results are reported.',
    'The build stayed inside the MVP scope and the file map; any file added outside it is listed and justified.',
    'No secrets, real client data, or production credentials appear in fixtures, logs, or committed defaults.',
    'The README names the exact run and verification commands for a new developer.',
    'No test was skipped, deleted, or weakened just to make the build pass.',
    'Follow-ups are listed separately and were not silently implemented.',
  ]
}

/** Render non-goals for the build. */
function nonGoalsFor(dream) {
  const lines = [
    '- Anything not listed in the MVP scope.',
    '- New integrations or data sources beyond those named in the MVP.',
  ]
  if (dream.type === 'feature') {
    lines.push('- Unrelated changes to the host project beyond the files this feature needs.')
  } else if (dream.type === 'service') {
    lines.push('- A full self-serve billing, onboarding, and admin suite unless the MVP names it.')
  } else {
    lines.push('- A hosted multi-tenant service, mobile app, or marketplace listing in v1.')
  }
  lines.push('- Marketing site, pricing page, or brand work.', '- A general-purpose framework instead of the one workflow the MVP owns.')
  return lines.join('\n')
}

/** Render the MVP bullet list. */
function renderMvp(checks) {
  if (checks.length === 0) return '- No MVP scope recorded. Do not build until the dream lists one.'
  return checks.map((check) => `- ${check.requirement}`).join('\n')
}

/** Render the acceptance-test checklist. */
function renderAcceptanceTests(checks) {
  if (checks.length === 0) return '_No MVP bullets; add scope before building._'
  return checks.map((check) => {
    const box = check.status === 'pass' ? '[x]' : '[ ]'
    const state = check.status === 'pass' ? '' : check.status === 'fail' ? ' **FAIL**' : ''
    const evidence = check.evidence === '' ? '_not recorded_' : check.evidence
    return [
      `- ${box} **${check.id}** — ${check.requirement}${state}`,
      `  - Expected: ${check.expected}`,
      `  - How: ${check.how}`,
      `  - Evidence: ${evidence}`,
    ].join('\n')
  }).join('\n')
}

/** Render competitors with their researched pricing and gap. */
function renderCompetitors(dream) {
  const entries = Array.isArray(dream.competitive?.competitors) ? dream.competitive.competitors : []
  const lines = []
  if (dream.competitive?.summary !== '') lines.push(dream.competitive?.summary ?? '')
  for (const entry of entries) {
    const parts = [`- ${entry.name}`]
    if (entry.pricing !== '') parts.push(` — ${entry.pricing}`)
    if (entry.gap !== '') parts.push(` (gap: ${entry.gap})`)
    if (entry.url !== '') parts.push(` ${entry.url}`)
    lines.push(parts.join(''))
  }
  return lines.length === 0 ? '- Unresearched; validate before building.' : lines.join('\n')
}

/** Render every source attached to the dream. */
function renderSources(dream) {
  const lines = []
  for (const entry of dream.sources?.web ?? []) {
    lines.push(`- web: ${entry.title === '' ? entry.url : entry.title} — ${entry.url}`)
  }
  for (const entry of dream.sources?.ideas ?? []) lines.push(`- idea: ${entry.title}`)
  for (const entry of dream.sources?.sessions ?? []) lines.push(`- session: ${entry.title}`)
  return lines.length === 0 ? '- None recorded.' : lines.join('\n')
}

/** Pick an unambiguous build target, or null when the scan cannot decide. */
function pickTarget(scan) {
  if (scan.manifests.length !== 1) return null
  const manifest = scan.manifests[0]
  const relative = displayPath(path.relative(scan.root, manifest.dir))
  return { path: relative === '' ? '.' : relative, name: manifest.name }
}

/** Render the file map from the scan and the packet's own output paths. */
function renderFileMap(scan, paths) {
  const lines = []
  lines.push(`Root: \`${displayPath(scan.root)}\`${scan.git.present ? ` on git branch \`${scan.git.branch ?? '(detached)'}\`` : ' (not a git repository)'}`)
  lines.push(`Stack: ${scan.stacks.join(' · ')}`)
  if (scan.topLevel.length > 0) {
    lines.push('', 'Top-level directories:')
    for (const entry of scan.topLevel) {
      lines.push(`- \`${entry.name}/\` — ${entry.capped ? '120+ files (scan capped)' : `${entry.files} file${entry.files === 1 ? '' : 's'}`}`)
    }
  }
  if (scan.topLevelFiles.length > 0) {
    lines.push('', 'Top-level files:')
    lines.push(`- ${scan.topLevelFiles.slice(0, 12).map((name) => `\`${name}\``).join(', ')}${scan.topLevelFiles.length > 12 ? ', …' : ''}`)
  }
  if (scan.manifests.length > 0) {
    lines.push('', 'Manifests:')
    for (const manifest of scan.manifests) {
      const relative = displayPath(path.relative(scan.root, manifest.path)) || manifest.kind
      const name = manifest.name === '' ? '' : ` name \`${manifest.name}\``
      const scripts = Object.keys(manifest.scripts)
      const scriptText = scripts.length === 0 ? '' : `; scripts: ${scripts.slice(0, 8).join(', ')}`
      lines.push(`- \`${relative}\` — ${manifest.kind}${name}${scriptText}`)
    }
  }
  if (Array.isArray(scan.matches) && scan.matches.length > 0) {
    lines.push('', 'Project names that share words with this dream (candidates, not a decision):')
    for (const match of scan.matches) {
      lines.push(`- \`${match.path}/\`${match.name === '' ? '' : ` (\`${match.name}\`)`} — shares: ${match.shared.join(', ')}`)
    }
  }
  lines.push('', 'Build target:')
  if (scan.target !== null && scan.target !== undefined) {
    const label = scan.target.path === '.' ? 'the repository root' : `\`${scan.target.path}/\``
    lines.push(`- ${label}${scan.target.name === '' ? '' : ` (\`${scan.target.name}\`)`} — the only project manifest found. Confirm it before editing.`)
  } else {
    lines.push('- Not selected by the scan. Confirm the target project and record the choice in the plan before editing.')
  }
  if (scan.tests.count > 0) {
    lines.push('', `Existing tests (${scan.tests.count} found within three levels):`)
    lines.push(...scan.tests.files.map((file) => `- \`${file}\``))
    if (scan.tests.count > scan.tests.files.length) lines.push(`- … ${scan.tests.count - scan.tests.files.length} more`)
  } else {
    lines.push('', 'Existing tests: none found.')
  }
  if (scan.docs.length > 0) {
    lines.push('', `Existing docs: ${scan.docs.map((doc) => `\`${doc.path}\`${doc.title === '' ? '' : ` (${doc.title})`}`).join(', ')}`)
  }
  lines.push('', 'Packet outputs:')
  lines.push(`- \`${paths.briefRelativePath}\` — this build packet`)
  lines.push(`- \`${paths.checksRelativePath}\` — acceptance state and evidence`)
  lines.push(`- \`${paths.templateRelativePath}\` — editable packet template`)
  lines.push('', 'Proposed touch points (confirm against the plan before editing):')
  lines.push('- The target project confirmed above, or a new project directory named in the plan.')
  lines.push('- Tests for each MVP bullet, next to the code they exercise.')
  lines.push('- The project README, with the exact run and verification commands.')
  lines.push('', 'If no target is listed above, choose the closest candidate or create a new directory and record the choice in the final report.')
  if (scan.warnings.length > 0) {
    lines.push('', 'Scan warnings:')
    lines.push(...scan.warnings.map((warning) => `- ${warning}`))
  }
  return lines.join('\n')
}

/** Render the discovered verification commands. */
function renderVerification(scan) {
  if (scan.commands.length === 0) {
    return '- No automated check was discovered. Add a runnable test or lint command and record it here before claiming completion.'
  }
  return scan.commands.map((entry) => {
    const where = entry.dir === null ? '' : ` (run in \`${entry.dir}\`)`
    return `- \`${entry.command}\` — ${entry.label}${where}`
  }).join('\n')
}

/** Render the human review checklist. */
function renderReview() {
  return reviewChecklist().map((item) => `- [ ] ${item}`).join('\n')
}

/**
 * Drop the leading template-ownership note from rendered packets. The note is
 * useful in `template.md`, but the Fleet session should not be told to edit a
 * generated packet.
 * @param template - template text.
 * @returns template text without the default leading note.
 */
function withoutTemplateNote(template) {
  return String(template).replace(/^\s*<!--\s*Build packet template\..*?-->\s*/su, '')
}

/**
 * Replace named `{{slot}}` placeholders.
 * @param template - template text.
 * @param values - slot values.
 * @returns rendered text and the still-unresolved slot names.
 */
export function renderTemplate(template, values) {
  const unresolved = new Set()
  const markdown = String(template).replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.-]*)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) return String(values[key] ?? '')
    unresolved.add(key)
    return match
  })
  return { markdown, unresolved: [...unresolved].sort() }
}

/**
 * Render one build packet.
 * @param dream - normalized dream.
 * @param options - template, scan, checks, and output paths.
 * @returns the packet markdown and unresolved slots.
 */
export function renderPacket(dream, options) {
  const checks = Array.isArray(options.checks) ? options.checks : buildChecks(dream)
  const scan = options.scan ?? {
    root: options.paths?.cwd ?? '', git: { present: false, branch: null }, stacks: ['Unknown'],
    topLevel: [], topLevelFiles: [], manifests: [], commands: [], tests: { count: 0, files: [] },
    docs: [], warnings: [], truncated: false,
  }
  const paths = options.paths ?? {}
  const score = typeof dream.totalScore === 'number' ? dream.totalScore : 0
  const scores = dream.scores ?? {}
  const values = {
    title: text(dream.title, 200) || 'Untitled dream',
    pitch: text(dream.pitch, 400) || 'No pitch recorded.',
    type: text(dream.type, 40) || 'feature',
    score: `${score}/25 (value ${scores.value ?? 1}, niche ${scores.niche ?? 1}, revenue ${scores.revenue ?? 1}, feasibility ${scores.feasibility ?? 1}, fit ${scores.fit ?? 1})`,
    dreamId: text(dream.id, 80),
    iteration: String(dream.iterationCount ?? 0),
    objective: [
      `Ship the smallest working version of **${text(dream.title, 200) || 'this dream'}** for ${stripPeriod(text(dream.targetUser, 1000)) || 'the named target user'}.`,
      '',
      `Core outcome: ${stripPeriod(text(dream.pitch, 400)) || 'see the problem below'}.`,
      '',
      `The build is done only when every acceptance check in \`${paths.checksRelativePath ?? 'the checks file'}\` is \`pass\` with recorded evidence.`,
    ].join('\n'),
    targetUser: text(dream.targetUser, 1000) || 'Not recorded; the build must not start.',
    nonGoals: nonGoalsFor(dream),
    mvpScope: renderMvp(checks),
    acceptanceTests: renderAcceptanceTests(checks),
    fileMap: renderFileMap(scan, paths),
    verification: renderVerification(scan),
    reviewChecklist: renderReview(),
    problem: text(dream.problem, MAX_FIELD) || 'Not recorded.',
    value: text(dream.value, MAX_FIELD) || 'Not recorded.',
    monetization: text(dream.monetization, 1000) || 'n/a',
    architecture: text(dream.architecture, 6000) || 'Not recorded.',
    competitors: renderCompetitors(dream),
    sources: renderSources(dream),
    effort: text(dream.effort, 300) || 'Not estimated.',
    briefPath: paths.briefRelativePath ?? '',
    checksPath: paths.checksRelativePath ?? '',
    templatePath: paths.templateRelativePath ?? '',
  }
  return renderTemplate(withoutTemplateNote(options.template ?? DEFAULT_TEMPLATE), values)
}

/** Resolve the output paths for one dream. */
function resolvePaths(root, outDir, dream, suffix = '') {
  const dir = path.resolve(root, outDir)
  const base = `${slugify(dream.title)}${suffix === '' ? '' : `-${suffix}`}`
  const relativeDir = displayPath(path.relative(root, dir))
  const prefix = relativeDir === '' ? '' : `${relativeDir}/`
  return {
    dir,
    base,
    briefPath: path.join(dir, `${base}.md`),
    checksPath: path.join(dir, `${base}.checks.json`),
    templatePath: path.join(dir, 'template.md'),
    briefRelativePath: `${prefix}${base}.md`,
    checksRelativePath: `${prefix}${base}.checks.json`,
    templateRelativePath: `${prefix}template.md`,
  }
}

/** Read a prior checks document, if any. */
async function readPriorChecks(file) {
  const parsed = await readJsonOptional(file)
  if (parsed === null || typeof parsed !== 'object') return undefined
  return parsed
}

/**
 * Refuse to write through a pre-existing symbolic link at an output path.
 * @param file - absolute output path.
 */
async function refuseSymlink(file) {
  try {
    const stat = await fs.lstat(file)
    if (stat.isSymbolicLink()) throw new Error(`refusing to write through a symbolic link: ${file}`)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return
    throw error
  }
}

/**
 * Render and write a build packet plus its checks file.
 *
 * The template is seeded from {@link DEFAULT_TEMPLATE} the first time; after
 * that the user owns it. The checks file keeps pass/fail state for checks whose
 * MVP bullet did not change. Both output paths are confined to the project
 * directory.
 *
 * @param options - dream, cwd, outDir, and optional templatePath.
 * @returns the written paths, checks, rendered markdown, and unresolved slots.
 */
export async function writeBrief(options) {
  const dream = options?.dream
  if (dream === null || typeof dream !== 'object' || typeof dream.id !== 'string' || dream.id === '') {
    throw new Error('a dream record with an id is required')
  }
  if (typeof dream.title !== 'string' || dream.title.trim() === '') {
    throw new Error('a dream title is required')
  }
  const root = path.resolve(options.cwd ?? process.cwd())
  let rootStat
  try {
    rootStat = await fs.stat(root)
  } catch {
    throw new Error(`project directory does not exist: ${root}`)
  }
  if (!rootStat.isDirectory()) throw new Error(`project path is not a directory: ${root}`)
  const outDirInput = typeof options.outDir === 'string' && options.outDir.trim() !== '' ? options.outDir.trim() : 'briefs'
  const dir = path.isAbsolute(outDirInput) ? path.resolve(outDirInput) : path.resolve(root, outDirInput)
  if (!isInside(root, dir)) throw new Error(`output directory must stay inside the project: ${outDirInput}`)

  const templateInput = typeof options.templatePath === 'string' && options.templatePath.trim() !== ''
    ? options.templatePath.trim()
    : null
  const templatePath = templateInput === null
    ? path.join(dir, 'template.md')
    : path.isAbsolute(templateInput) ? path.resolve(templateInput) : path.resolve(root, templateInput)
  if (!isInside(root, templatePath)) throw new Error(`template path must stay inside the project: ${templateInput}`)

  await fs.mkdir(dir, { recursive: true })
  const realRoot = await fs.realpath(root)
  if (!await realContained(realRoot, dir)) throw new Error(`output directory escapes the project through a link: ${outDirInput}`)
  if (!await realContained(realRoot, templatePath)) throw new Error(`template path escapes the project through a link: ${templateInput ?? templatePath}`)
  await fs.mkdir(path.dirname(templatePath), { recursive: true })
  let template = await readOptional(templatePath)
  if (template === undefined) {
    template = DEFAULT_TEMPLATE
    await fs.writeFile(templatePath, template, 'utf8')
  }

  const scan = await scanRepo(root, { exclude: [dir] })
  scan.matches = matchProjects(scan, dream)
  scan.target = pickTarget(scan)
  let paths = resolvePaths(root, outDirInput, dream)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prior = await readPriorChecks(paths.checksPath)
    if (prior === undefined || prior.dreamId === dream.id) break
    paths = resolvePaths(root, outDirInput, dream, dream.id.replace(/^drm_/u, '').slice(0, 6) || String(attempt + 2))
  }

  const prior = await readPriorChecks(paths.checksPath)
  const checks = mergeChecks(prior, buildChecks(dream))
  const rendered = renderPacket(dream, { template, scan, checks, paths })
  const checksDocument = {
    version: 1,
    dreamId: dream.id,
    title: text(dream.title, 200),
    brief: paths.briefRelativePath,
    checks: checks.map((check) => ({
      id: check.id,
      requirement: check.requirement,
      expected: check.expected,
      how: check.how,
      kind: check.kind,
      status: check.status,
      evidence: check.evidence,
    })),
    review: reviewChecklist(),
  }
  const markdown = rendered.markdown.endsWith('\n') ? rendered.markdown : `${rendered.markdown}\n`
  await refuseSymlink(paths.briefPath)
  await refuseSymlink(paths.checksPath)
  await fs.writeFile(paths.briefPath, markdown, 'utf8')
  await fs.writeFile(paths.checksPath, `${JSON.stringify(checksDocument, null, 2)}\n`, 'utf8')

  return {
    slug: paths.base,
    root,
    briefPath: paths.briefPath,
    checksPath: paths.checksPath,
    templatePath,
    briefRelativePath: paths.briefRelativePath,
    checksRelativePath: paths.checksRelativePath,
    templateRelativePath: paths.templateRelativePath,
    markdown,
    checks: checksDocument.checks,
    scan,
    unresolvedSlots: rendered.unresolved,
  }
}

/**
 * Build the prompt seeded into a Fleet session from a written packet.
 * @param written - result of {@link writeBrief}.
 * @returns the prompt text.
 */
export function buildFleetPrompt(written) {
  const MAX_PROMPT = 30000
  const packet = written.markdown.trimEnd()
  const body = packet.length <= MAX_PROMPT
    ? packet
    : `${packet.slice(0, MAX_PROMPT)}\n\n_… packet truncated at ${MAX_PROMPT} characters; the full text is on disk._`
  return [
    body,
    '',
    '---',
    '',
    `This packet is also saved at \`${written.briefRelativePath}\`; its acceptance checks are at \`${written.checksRelativePath}\`. Read both from the project root if this message was truncated, and update the checks file with pass/fail and evidence as you verify.`,
  ].join('\n')
}
