/**
 * Unit tests for the build-packet renderer, repository scan, acceptance checks,
 * and output containment. Run with `node --test` from the plugin directory.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildChecks,
  buildFleetPrompt,
  DEFAULT_TEMPLATE,
  mergeChecks,
  renderPacket,
  scanRepo,
  slugify,
  writeBrief,
} from '../brief.js'

/** A representative normalized dream. */
function dream(overrides = {}) {
  return {
    id: 'drm_test123456',
    title: 'Test Packet',
    pitch: 'Turn a reviewed dream into a build packet.',
    type: 'feature',
    problem: 'Briefs are handwritten and drift.',
    targetUser: 'Solo builders running several builds.',
    value: 'The same structure and review checklist every time.',
    monetization: 'n/a',
    competitive: {
      summary: 'Spec tooling starts from a blank prompt.',
      competitors: [{ name: 'Spec Kit', url: '', pricing: 'Free', gap: 'No dream board' }],
    },
    architecture: 'Host plugin; template renderer; filesystem scan.',
    mvpScope: ['Import CSV files', 'Export a PDF report', 'Persist an audit log'],
    effort: '1 week',
    sources: { web: [], ideas: [], sessions: [] },
    scores: { value: 3, niche: 4, revenue: 1, feasibility: 5, fit: 5 },
    totalScore: 18,
    iterationCount: 0,
    status: 'ready_for_review',
    tags: [],
    ...overrides,
  }
}

/** Create a temporary project fixture with a Node manifest, source, and test. */
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dream-brief-'))
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fixture-project',
    version: '1.0.0',
    scripts: { test: 'vitest run', lint: 'eslint .', build: 'tsc -p .' },
    devDependencies: { typescript: '^5.0.0', vitest: '^2.0.0' },
  }, null, 2))
  await fs.mkdir(path.join(dir, 'src'))
  await fs.writeFile(path.join(dir, 'src', 'app.ts'), 'export const app = true\n')
  await fs.mkdir(path.join(dir, 'test'))
  await fs.writeFile(path.join(dir, 'test', 'app.test.ts'), 'import { test } from "vitest"\n')
  await fs.writeFile(path.join(dir, 'README.md'), '# Fixture project\n\nRun it.\n')
  return dir
}

test('slugify produces bounded file-safe names', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world')
  assert.equal(slugify('  '), 'dream')
  assert.equal(slugify('Café / Réconciliation'), 'cafe-reconciliation')
  assert.equal(slugify('CON'), 'con-dream')
  assert.ok(slugify('x'.repeat(200)).length <= 60)
})

test('scanRepo finds the stack, scripts, and tests', async () => {
  const dir = await fixture()
  const scan = await scanRepo(dir)
  assert.equal(scan.root, path.resolve(dir))
  assert.ok(scan.stacks.includes('Node.js'))
  assert.ok(scan.stacks.includes('TypeScript'))
  assert.deepEqual(scan.commands.map((entry) => entry.command), ['npm run test', 'npm run lint', 'npm run build'])
  assert.equal(scan.tests.count, 1)
  assert.ok(scan.tests.files.includes('test/app.test.ts'))
  assert.equal(scan.docs[0].title, 'Fixture project')
  assert.equal(scan.git.present, false)
})

test('scanRepo ignores node_modules and reports a missing project', async () => {
  const dir = await fixture()
  await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
  await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'index.test.js'), '')
  const scan = await scanRepo(dir)
  assert.equal(scan.tests.count, 1)
  assert.ok(!scan.topLevel.some((entry) => entry.name === 'node_modules'))
  await assert.rejects(scanRepo(path.join(dir, 'missing')), /does not exist/)
})

test('buildChecks produces exactly one pending check per MVP bullet', () => {
  const checks = buildChecks(dream())
  assert.equal(checks.length, 3)
  assert.deepEqual(checks.map((check) => check.id), ['MVP-1', 'MVP-2', 'MVP-3'])
  assert.ok(checks.every((check) => check.status === 'pending'))
  assert.match(checks[0].expected, /fixture imports without manual edits/)
  assert.match(checks[0].how, /Import a representative fixture/)
  assert.match(checks[2].expected, /restart or resume/)
  assert.match(checks[2].how, /stored record/)
  assert.deepEqual(buildChecks(dream({ mvpScope: [] })), [])
})

test('mergeChecks keeps evidence only for an unchanged requirement', () => {
  const first = buildChecks(dream())
  const prior = {
    dreamId: dream().id,
    checks: first.map((check, index) => index === 1
      ? { ...check, status: 'pass', evidence: 'Opened report.pdf and checked totals.' }
      : check),
  }
  const merged = mergeChecks(prior, first)
  assert.equal(merged[1].status, 'pass')
  assert.match(merged[1].evidence, /report\.pdf/)
  const changed = first.map((check, index) => index === 1 ? { ...check, requirement: 'Export a PNG instead.' } : check)
  assert.equal(mergeChecks(prior, changed)[1].status, 'pending')
})

test('renderPacket fills every documented section', () => {
  const checks = buildChecks(dream())
  const scan = {
    root: 'C:/work/project', git: { present: true, branch: 'main' }, stacks: ['Node.js'],
    topLevel: [{ name: 'src', files: 4, capped: false }], topLevelFiles: ['package.json'],
    manifests: [{ path: 'C:/work/project/package.json', kind: 'package.json', name: 'demo', scripts: { test: 'vitest run' }, dir: 'C:/work/project', dependencies: [] }],
    commands: [{ command: 'npm run test', label: 'package script "test"', dir: null }],
    tests: { count: 1, files: ['test/app.test.ts'] }, docs: [{ path: 'README.md', title: 'Demo' }],
    warnings: [], truncated: false,
  }
  const paths = {
    cwd: 'C:/work/project',
    briefRelativePath: 'briefs/test-packet.md',
    checksRelativePath: 'briefs/test-packet.checks.json',
    templateRelativePath: 'briefs/template.md',
  }
  const rendered = renderPacket(dream(), { template: DEFAULT_TEMPLATE, scan, checks, paths })
  assert.deepEqual(rendered.unresolved, [])
  for (const needle of [
    '# Build packet: Test Packet',
    'briefs/test-packet.checks.json',
    'npm run test',
    'test/app.test.ts',
    '**MVP-1**',
    '## Human review checklist',
    'Spec Kit',
  ]) {
    assert.ok(rendered.markdown.includes(needle), `missing ${needle}`)
  }
  assert.ok(!rendered.markdown.includes('{{'))
})

test('writeBrief writes a deterministic packet and a checks file', async () => {
  const dir = await fixture()
  const written = await writeBrief({ dream: dream(), cwd: dir })
  assert.equal(written.briefRelativePath, 'briefs/test-packet.md')
  assert.equal(written.checksRelativePath, 'briefs/test-packet.checks.json')
  assert.equal(written.checks.length, 3)
  assert.equal(written.unresolvedSlots.length, 0)
  const first = await fs.readFile(path.join(dir, 'briefs', 'test-packet.md'), 'utf8')
  const checks = JSON.parse(await fs.readFile(path.join(dir, 'briefs', 'test-packet.checks.json'), 'utf8'))
  assert.equal(checks.dreamId, 'drm_test123456')
  assert.equal(checks.checks.length, 3)
  assert.ok(checks.review.some((line) => /pending/.test(line)))
  assert.ok(first.includes('the only project manifest found'))
  assert.ok(first.includes('the repository root'))
  assert.ok(first.includes('npm run test'))
  assert.ok(first.includes('test/app.test.ts'))
  assert.ok(await fs.stat(path.join(dir, 'briefs', 'template.md')))

  const second = await writeBrief({ dream: dream(), cwd: dir })
  assert.equal(second.markdown, written.markdown)
})

test('writeBrief preserves a recorded pass and resets changed checks', async () => {
  const dir = await fixture()
  await writeBrief({ dream: dream(), cwd: dir })
  const file = path.join(dir, 'briefs', 'test-packet.checks.json')
  const document = JSON.parse(await fs.readFile(file, 'utf8'))
  document.checks[1].status = 'pass'
  document.checks[1].evidence = 'Generated report.pdf and checked the totals.'
  await fs.writeFile(file, JSON.stringify(document, null, 2))
  const written = await writeBrief({ dream: dream(), cwd: dir })
  assert.equal(written.checks[1].status, 'pass')
  assert.equal(written.checks[1].evidence, 'Generated report.pdf and checked the totals.')
  assert.ok(written.markdown.includes('[x] **MVP-2**'))

  const changed = await writeBrief({
    dream: dream({ mvpScope: ['Import CSV files', 'Export a PNG report', 'Persist an audit log'] }),
    cwd: dir,
  })
  assert.equal(changed.checks[1].status, 'pending')
  assert.equal(changed.checks[1].evidence, '')
})

test('writeBrief rejects output and template paths outside the project', async () => {
  const dir = await fixture()
  await assert.rejects(writeBrief({ dream: dream(), cwd: dir, outDir: '../escape' }), /inside the project/)
  await assert.rejects(writeBrief({ dream: dream(), cwd: dir, templatePath: '../escape.md' }), /inside the project/)
  await assert.rejects(writeBrief({ dream: dream(), cwd: path.join(dir, 'missing') }), /does not exist/)
})

test('writeBrief refuses an output directory that links outside the project', async (t) => {
  const dir = await fixture()
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dream-brief-outside-'))
  try {
    await fs.symlink(outside, path.join(dir, 'briefs'), 'junction')
  } catch {
    t.skip('this platform did not allow creating a directory link')
    return
  }
  await assert.rejects(writeBrief({ dream: dream(), cwd: dir }), /escapes the project through a link/)
})

test('a malformed checks file is regenerated instead of failing the packet', async () => {
  const dir = await fixture()
  await fs.mkdir(path.join(dir, 'briefs'))
  await fs.writeFile(path.join(dir, 'briefs', 'test-packet.checks.json'), '{not json')
  const written = await writeBrief({ dream: dream(), cwd: dir })
  assert.equal(written.checks.length, 3)
  assert.ok(written.checks.every((check) => check.status === 'pending'))
})

test('an edited template wins and unknown slots stay visible', async () => {
  const dir = await fixture()
  const template = path.join(dir, 'briefs', 'custom.md')
  await fs.mkdir(path.dirname(template), { recursive: true })
  await fs.writeFile(template, '# {{title}}\n\n{{objective}}\n\n{{typo}}\n')
  const written = await writeBrief({ dream: dream(), cwd: dir, templatePath: 'briefs/custom.md' })
  assert.deepEqual(written.unresolvedSlots, ['typo'])
  assert.ok(written.markdown.includes('# Test Packet'))
  assert.ok(written.markdown.includes('{{typo}}'))
})

test('title collisions get a dream-id suffix instead of overwriting', async () => {
  const dir = await fixture()
  await writeBrief({ dream: dream(), cwd: dir })
  const other = await writeBrief({
    dream: dream({ id: 'drm_other99999', title: 'Test Packet' }),
    cwd: dir,
  })
  assert.notEqual(other.checksPath, path.join(dir, 'briefs', 'test-packet.checks.json'))
  assert.match(other.briefRelativePath, /test-packet-other9/)
  const document = JSON.parse(await fs.readFile(other.checksPath, 'utf8'))
  assert.equal(document.dreamId, 'drm_other99999')
})

test('writeBrief names projects whose package words match the dream', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dream-brief-'))
  await fs.mkdir(path.join(dir, 'test-packet-tools'))
  await fs.writeFile(path.join(dir, 'test-packet-tools', 'package.json'), JSON.stringify({ name: 'test-packet-tools', scripts: { test: 'node --test' } }))
  const written = await writeBrief({ dream: dream(), cwd: dir })
  assert.ok(written.markdown.includes('Project names that share words with this dream'))
  assert.match(written.markdown, /test-packet-tools/)
  assert.match(written.markdown, /shares: packet/)
  assert.match(written.markdown, /`test-packet-tools\/`/)
  assert.match(written.markdown, /the only project manifest found/)
})

test('buildFleetPrompt carries the packet and its paths', async () => {
  const dir = await fixture()
  const written = await writeBrief({ dream: dream(), cwd: dir })
  const prompt = buildFleetPrompt(written)
  assert.ok(prompt.includes('# Build packet: Test Packet'))
  assert.ok(prompt.includes('briefs/test-packet.md'))
  assert.ok(prompt.includes('briefs/test-packet.checks.json'))
  assert.ok(prompt.length > 1000)
})
