#!/usr/bin/env node
/**
 * Static prompt-contract tests for the Hivemind context-vault surfaces.
 *
 * Every assertion is an index-based ordering invariant over instruction files
 * that agents actually load. A failure means a prompt surface regressed:
 * exploration can start before the vault gate, the post-goal checkpoint can run
 * before the verification gate, tier wiring can disappear, or a note can leak
 * the authoring project's name. Fix the prompt; do not relax the test.
 *
 * Zero dependencies: Node built-in test runner plus the locked contract module.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { BUDGETS, EXIT_CODES, estimateTokens } from '../../scripts/hive/contracts.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROMPTS_DIR = join(ROOT, 'vault-kit', 'prompts')
const FIXTURES_DIR = join(ROOT, 'tests', 'fixtures', 'prompts')

// Assembled at runtime so this repository never contains the authoring
// project's name as a literal string.
const AUTHORING_LEAK = ['Hive', 'ly'].join('')

const GATE_NEEDLES = Object.freeze([
  'vault-gate:',
  'vault-lifecycle.mjs detect',
  'model-tier.mjs resolve --role spec-architect',
])

const VAULT_KIT_PROMPTS = Object.freeze([
  'pre-exploration-gate.md',
  'post-goal-checkpoint.md',
  'librarian-refresh.md',
  'handoff-rules.md',
])

const PATH_MAP = JSON.parse(readFileSync(join(ROOT, 'docs', 'context-vault', 'PATH-MAP.json'), 'utf8'))

function pathFor(alias) {
  const rel = PATH_MAP?.paths?.[alias]
  assert.equal(typeof rel, 'string', `PATH-MAP.json must declare paths.${alias}`)
  assert.ok(rel.length > 0, `PATH-MAP.json: paths.${alias} must not be empty`)
  return rel
}

function readText(absPath) {
  assert.ok(existsSync(absPath), `missing file: ${absPath}`)
  const text = readFileSync(absPath, 'utf8')
  assert.ok(text.trim().length > 0, `empty file: ${absPath}`)
  return text
}

function readRepoFile(relPath) {
  return readText(join(ROOT, relPath))
}

function readFixture(name) {
  return readText(join(FIXTURES_DIR, name))
}

const EXPLORATION_WORD = /\b(?:read|grep|glob)\b/i

function firstExplorationIndex(text) {
  const match = EXPLORATION_WORD.exec(text)
  return match ? match.index : Number.POSITIVE_INFINITY
}

function requireNeedle(text, needle, label) {
  const index = text.indexOf(needle)
  assert.notEqual(index, -1, `${label}: missing required marker ${JSON.stringify(needle)}`)
  return index
}

function headingIndex(text, pattern, label) {
  const match = pattern.exec(text)
  assert.ok(match, `${label}: missing required section heading ${pattern}`)
  return match.index
}

/**
 * Every gate marker must appear strictly before the first read/grep/glob
 * instruction. Returns the index of the exploration boundary.
 */
function validatePreExplorationOrdering(text, options) {
  const { label, needles = GATE_NEEDLES } = options
  const boundary = firstExplorationIndex(text)
  assert.ok(
    Number.isFinite(boundary),
    `${label}: expected at least one read/grep/glob instruction after the gate`,
  )
  for (const needle of needles) {
    const index = requireNeedle(text, needle, label)
    assert.ok(
      index < boundary,
      `${label}: ${JSON.stringify(needle)} at ${index} must appear strictly before the first read/grep/glob instruction at ${boundary}`,
    )
  }
  return boundary
}

/**
 * The terminal checkpoint must execute after the verification gate.
 *
 * Forward references are legal: an earlier section may point at the terminal
 * step ("then proceed to post-goal-checkpoint") without executing it. Markers
 * that are referenced ahead of the gate are therefore checked on their last
 * occurrence, while executable commands are checked on their first occurrence.
 */
function validateTerminalOrdering(text, options) {
  const { label, anchor, needle, occurrence = 'first' } = options
  assert.ok(
    Number.isFinite(anchor) && anchor >= 0,
    `${label}: verification-gate anchor is required for ${JSON.stringify(needle)}`,
  )
  const index = occurrence === 'last' ? text.lastIndexOf(needle) : text.indexOf(needle)
  assert.notEqual(index, -1, `${label}: missing required marker ${JSON.stringify(needle)}`)
  assert.ok(
    index > anchor,
    `${label}: ${JSON.stringify(needle)} at ${index} must appear strictly after the verification gate at ${anchor}`,
  )
  return index
}

function validateNoGlobBeforeGate(text, options) {
  const { label, gateNeedle = 'vault-gate:' } = options
  const gateIndex = requireNeedle(text, gateNeedle, label)
  const globIndex = text.indexOf('glob **')
  assert.ok(
    globIndex === -1 || globIndex > gateIndex,
    `${label}: "glob **" at ${globIndex} must not precede the gate marker at ${gateIndex}`,
  )
  return gateIndex
}

function validateNoAuthoringLeak(text, label) {
  assert.ok(
    !text.toLowerCase().includes(AUTHORING_LEAK.toLowerCase()),
    `${label}: contains the authoring project name`,
  )
}

test('PATH-MAP resolves every prompt surface under test', () => {
  for (const alias of ['spec_architect_agent', 'brainstorm_command', 'swarm_command', 'root_agents']) {
    const rel = pathFor(alias)
    assert.ok(existsSync(join(ROOT, rel)), `PATH-MAP paths.${alias} -> ${rel} does not exist`)
  }
})

test('spec-architect emits the vault gate before any exploration instruction', () => {
  const text = readRepoFile(pathFor('spec_architect_agent'))
  const boundary = validatePreExplorationOrdering(text, { label: 'spec-architect' })
  for (const state of ['absent', 'partial', 'present_healthy', 'present_unhealthy']) {
    assert.ok(text.includes(state), `spec-architect: must branch on vault state ${state}`)
  }
  const firstInstruction = text.slice(boundary, boundary + 80)
  assert.match(
    firstInstruction,
    /vault/i,
    'spec-architect: the first read instruction after the gate must be a vault read, not repository exploration',
  )
})

test('brainstorm gates before exploration, forbids mid-brainstorm vault creation, wires the checkpoint', () => {
  const text = readRepoFile(pathFor('brainstorm_command'))
  const gateIndex = validateNoGlobBeforeGate(text, { label: 'brainstorm' })
  validatePreExplorationOrdering(text, { label: 'brainstorm' })
  const firstInstruction = text.slice(firstExplorationIndex(text), firstExplorationIndex(text) + 80)
  assert.match(
    firstInstruction,
    /vault/i,
    'brainstorm: the first read instruction after the gate must be a vault read, not repository exploration',
  )
  assert.match(
    text,
    /never create a vault mid-brainstorm/i,
    'brainstorm: must explicitly forbid mid-brainstorm vault creation',
  )
  assert.match(text, /post-goal-checkpoint/, 'brainstorm: must wire the terminal post-goal-checkpoint')

  const launchIndex = text.indexOf('Launch /swarm')
  assert.notEqual(launchIndex, -1, 'brainstorm: must offer to launch /swarm')
  const checkpointIndex = text.indexOf('post-goal-checkpoint')
  assert.ok(
    checkpointIndex > launchIndex,
    'brainstorm: the /swarm launch must reference post-goal-checkpoint after it is offered',
  )
  const planIndex = text.indexOf('vault-lifecycle.mjs plan')
  assert.ok(planIndex > launchIndex, 'brainstorm: the /swarm launch must route to vault-lifecycle.mjs plan')
  assert.ok(gateIndex < launchIndex, 'brainstorm: the gate must precede the /swarm launch offer')
})

test('swarm runs the post-goal checkpoint strictly after the Wave 3 verification gate', () => {
  const text = readRepoFile(pathFor('swarm_command'))
  const gateAnchor = headingIndex(text, /^##[ \t]*4\.[ \t]+After Wave 3/m, 'swarm')
  const terminalAnchor = headingIndex(text, /^##[ \t]*5\./m, 'swarm')
  assert.ok(
    terminalAnchor > gateAnchor,
    'swarm: the terminal checkpoint section must follow the Wave 3 verification gate section',
  )

  requireNeedle(text, 'post-goal-checkpoint', 'swarm')
  validateTerminalOrdering(text, {
    label: 'swarm',
    anchor: gateAnchor,
    needle: 'vault-lifecycle.mjs plan',
    occurrence: 'first',
  })
  validateTerminalOrdering(text, {
    label: 'swarm',
    anchor: gateAnchor,
    needle: 'post-goal-checkpoint',
    occurrence: 'last',
  })

  const terminal = text.slice(terminalAnchor)
  requireNeedle(terminal, 'post-goal-checkpoint', 'swarm terminal section')
  requireNeedle(terminal, 'vault-lifecycle.mjs plan', 'swarm terminal section')
  requireNeedle(terminal, 'plan().data.question', 'swarm terminal section')
  assert.match(terminal, /`question` tool/i, 'swarm: terminal step must call the question tool')
  requireNeedle(terminal, '`Yes`', 'swarm terminal section')
  requireNeedle(terminal, '`No`', 'swarm terminal section')
})

test('root AGENTS.md carries the vault-first, checkpoint, and architect-tier invariants', () => {
  const text = readRepoFile(pathFor('root_agents'))
  assert.match(text, /vault-first/i, 'AGENTS.md: vault-first invariant missing')
  requireNeedle(text, 'post-goal-checkpoint', 'AGENTS.md')
  requireNeedle(text, 'tier(spec-architect) >= tier(builder) + 1', 'AGENTS.md')

  const sectionStart = headingIndex(text, /^##[ \t]*8\./m, 'AGENTS.md')
  const rest = text.slice(sectionStart)
  const nextHeading = /^##[ \t]*9\./m.exec(rest)
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest
  const lineCount = section.replace(/\s+$/, '').split('\n').length
  assert.ok(lineCount <= 40, `AGENTS.md: section 8 must stay <= 40 lines, found ${lineCount}`)
  assert.match(section, /vault-first/i, 'AGENTS.md section 8: vault-first invariant missing')
  requireNeedle(section, 'tier(spec-architect) >= tier(builder) + 1', 'AGENTS.md section 8')
  requireNeedle(section, 'question', 'AGENTS.md section 8')
})

test('vault-kit prompts exist, stay bounded, and carry no authoring-project leak', () => {
  for (const name of VAULT_KIT_PROMPTS) {
    const label = `vault-kit/prompts/${name}`
    const text = readText(join(PROMPTS_DIR, name))
    validateNoAuthoringLeak(text, label)
    const tokens = estimateTokens(text)
    assert.ok(
      tokens <= BUDGETS.PRE_EXPLORATION_TOKENS,
      `${label}: ${tokens} estimated tokens exceeds the ${BUDGETS.PRE_EXPLORATION_TOKENS}-token prompt cap`,
    )
  }
})

test('librarian refresh protocol pins drift scoping, slice caps, and the two exit-0 checks', () => {
  const text = readRepoFile('vault-kit/prompts/librarian-refresh.md')
  for (const marker of [
    'vault-lifecycle.mjs update',
    'source_hash',
    'path#symbol',
    '--since',
    'slice --file',
    '--symbol',
    '120',
    '400',
    'vault.mjs index',
    'check --strict',
    '_schema',
    'README.md',
  ]) {
    requireNeedle(text, marker, 'librarian-refresh')
  }
  assert.match(text, /never edit/i, 'librarian-refresh: must forbid editing schema, vault README, and application source')
  assert.match(text, /application source code/i, 'librarian-refresh: must name application source code as out of scope')
  assert.match(text, /both commands exit `0`/i, 'librarian-refresh: verify step must require both commands to exit 0')
})

test('handoff protocol pins the CLI shape, caps, immutability, and orchestrator read path', () => {
  const text = readRepoFile('vault-kit/prompts/handoff-rules.md')
  for (const marker of [
    'handoff write',
    '--run',
    '--slice',
    '--status',
    '--owner',
    '90-handoffs',
    '--runs-dir',
    'handoff list',
    'at most 5 bullets',
    '400 estimated tokens',
    'exits `3`',
    'immutable',
  ]) {
    requireNeedle(text, marker, 'handoff-rules')
  }
  assert.match(
    text,
    /zero fenced code blocks/i,
    'handoff-rules: must cap digests at zero fenced code blocks, diffs, and raw logs',
  )
  assert.match(text, /\.handoff\.md/, 'handoff-rules: must name the on-disk digest filename extension')
})

test('documented handoff caps match the locked contract budgets', () => {
  assert.equal(BUDGETS.HANDOFF_MAX_BULLETS, 5)
  assert.equal(BUDGETS.HANDOFF_BODY_TOKENS, 400)
  assert.equal(EXIT_CODES.NOT_FOUND, 3)

  const text = readRepoFile('vault-kit/prompts/handoff-rules.md')
  requireNeedle(text, `at most ${BUDGETS.HANDOFF_MAX_BULLETS} bullets`, 'handoff-rules')
  requireNeedle(text, `${BUDGETS.HANDOFF_BODY_TOKENS} estimated tokens`, 'handoff-rules')
  requireNeedle(text, 'exits ' + '`' + EXIT_CODES.NOT_FOUND + '`', 'handoff-rules')
})

test('pre-exploration ordering validator rejects exploration before the gate', () => {
  const inverted = readFixture('inverted-pre-exploration.md')
  assert.throws(
    () => validatePreExplorationOrdering(inverted, { label: 'fixture' }),
    /strictly before the first read\/grep\/glob instruction/,
  )

  const valid = readFixture('valid-pre-exploration.md')
  assert.doesNotThrow(() => validatePreExplorationOrdering(valid, { label: 'fixture' }))
})

test('pre-exploration ordering validator rejects a gate that skips vault detection', () => {
  const text = readFixture('missing-detect.md')
  assert.throws(
    () => validatePreExplorationOrdering(text, { label: 'fixture' }),
    /vault-lifecycle\.mjs detect/,
  )
})

test('glob ordering validator rejects a glob scan that precedes the gate', () => {
  const text = readFixture('glob-before-gate.md')
  assert.throws(() => validateNoGlobBeforeGate(text, { label: 'fixture' }), /must not precede the gate marker/)
  assert.doesNotThrow(() => validateNoGlobBeforeGate(readRepoFile(pathFor('brainstorm_command')), { label: 'brainstorm' }))
})

test('terminal ordering validator rejects a checkpoint that executes before the Wave 3 gate', () => {
  const text = readFixture('premature-checkpoint.md')
  const anchor = headingIndex(text, /^##[ \t]+Wave 3/m, 'fixture')
  assert.throws(
    () => validateTerminalOrdering(text, { label: 'fixture', anchor, needle: 'vault-lifecycle.mjs plan' }),
    /strictly after the verification gate/,
  )
  assert.throws(
    () =>
      validateTerminalOrdering(text, {
        label: 'fixture',
        anchor,
        needle: 'post-goal-checkpoint',
        occurrence: 'last',
      }),
    /strictly after the verification gate/,
  )
})

test('authoring-leak validator rejects the project name and accepts clean copy', () => {
  assert.throws(
    () => validateNoAuthoringLeak(`Checkpoint into the ${AUTHORING_LEAK} vault.`, 'inline'),
    /authoring project name/,
  )
  assert.doesNotThrow(() => validateNoAuthoringLeak('Checkpoint into the context vault.', 'inline'))
})
