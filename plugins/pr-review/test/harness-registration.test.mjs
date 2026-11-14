#!/usr/bin/env node
/**
 * Tests for durable harness registration.
 * Run with: node --test plugins/pr-review/test/harness-registration.test.mjs
 *
 * Every test uses an isolated temporary config directory. Nothing here touches
 * the live ~/.config/opencode harness.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  JsoncParseError,
  applyHarnessRegistration,
  parseJsonc,
  registerHarness
} from '../src/harness-registration.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER = join(HERE, '..', 'src', 'harness-registration.mjs')
const DENY_ALL = [{ action: '*', resource: '*', effect: 'deny' }]
const REVIEWER_ALLOW = { action: 'subagent', resource: 'pr-reviewer', effect: 'allow' }

function tempConfig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-harness-'))
  mkdirSync(join(dir, 'agents'), { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeConfig(dir, text) {
  const path = join(dir, 'opencode.json')
  writeFileSync(path, text, 'utf8')
  return path
}

function writeReviewer(dir, model = 'opencode/deepseek-v4.1-flash') {
  const path = join(dir, 'agents', 'pr-reviewer.md')
  writeFileSync(
    path,
    [
      '---',
      'description: Read-only specialist PR review worker.',
      'mode: subagent',
      `model: ${model}`,
      'steps: 12',
      'permissions:',
      '  - action: "*"',
      '    resource: "*"',
      '    effect: deny',
      '---',
      '',
      'Body must stay intact.',
      ''
    ].join('\n'),
    'utf8'
  )
  return path
}

function legacyConfig({ reviewer = false, includeReviewerAllow = false } = {}) {
  const allows = [
    'scout',
    'researcher',
    'builder',
    'spec-architect',
    'surgeon',
    'verifier',
    'auditor',
    'oracle'
  ]
  const lines = []
  lines.push('{')
  lines.push('  // unrelated comment must survive')
  lines.push('  "unrelated": { "keep": true, "nested": [1, 2], },')
  lines.push('  "agents": {')
  lines.push('    "hivemind-architect": {')
  lines.push('      "model": "openai/gpt-6.1-sol",')
  lines.push('      "permissions": [')
  lines.push('        { "action": "subagent", "resource": "*", "effect": "deny" },')
  for (const role of allows) {
    lines.push(
      `        { "action": "subagent", "resource": "${role}", "effect": "allow" },`
    )
  }
  if (includeReviewerAllow) {
    lines.push(
      '        { "action": "subagent", "resource": "pr-reviewer", "effect": "allow" },'
    )
  }
  lines.push('      ],')
  lines.push('    },')
  lines.push('    "researcher": { "model": "deepseek/deepseek-flash" },')
  lines.push('    "builder": { "model": "deepseek/deepseek-flash" },')
  if (reviewer) {
    lines.push('    "pr-reviewer": {')
    lines.push('      "mode": "subagent",')
    lines.push('      "model": "deepseek/deepseek-flash",')
    lines.push('      "permissions": [')
    lines.push('        { "action": "*", "resource": "*", "effect": "deny" }')
    lines.push('      ],')
    lines.push('    },')
  }
  lines.push('  },')
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}

function permissionSummary(root) {
  const architect = root.agents['hivemind-architect']
  return architect.permissions
}

function trailingCommentObjectConfig({ comma = false } = {}) {
  const sep = comma ? ',' : ''
  return [
    '{',
    '  // unrelated comment must survive',
    '  "unrelated": { "keep": true },',
    '  "agents": {',
    '    "hivemind-architect": {',
    '      "permissions": [',
    '        { "action": "subagent", "resource": "*", "effect": "deny" },',
    '        { "action": "subagent", "resource": "pr-reviewer", "effect": "allow" }',
    '      ]',
    '    },',
    '    "researcher": { "model": "deepseek/deepseek-flash" },',
    '    "builder": { "model": "deepseek/deepseek-flash" },',
    '    "pr-reviewer": {',
    '      "mode": "subagent",',
    `      "model": "deepseek/deepseek-flash"${sep} // reviewer object trailing comment`,
    '    }',
    '  }',
    '}',
    ''
  ].join('\n')
}

function trailingCommentArrayConfig({ comma = false } = {}) {
  const sep = comma ? ',' : ''
  return [
    '{',
    '  // unrelated comment must survive',
    '  "unrelated": { "keep": true },',
    '  "agents": {',
    '    "hivemind-architect": {',
    '      "permissions": [',
    '        { "action": "subagent", "resource": "*", "effect": "deny" },',
    `        { "action": "subagent", "resource": "pr-reviewer", "effect": "deny" }${sep} // architect array trailing comment`,
    '      ]',
    '    },',
    '    "researcher": { "model": "deepseek/deepseek-flash" },',
    '    "builder": { "model": "deepseek/deepseek-flash" },',
    '    "pr-reviewer": {',
    '      "mode": "subagent",',
    '      "model": "deepseek/deepseek-flash",',
    '      "permissions": [ { "action": "*", "resource": "*", "effect": "deny" } ]',
    '    }',
    '  }',
    '}',
    ''
  ].join('\n')
}

test('JSONC comments/trailing commas survive, unrelated settings preserved, fixes applied', (t) => {
  const dir = tempConfig(t)
  const configPath = writeConfig(dir, legacyConfig())
  const reviewerPath = writeReviewer(dir)
  const beforeReviewer = readFileSync(reviewerPath, 'utf8')

  const stamp = '20260101_010203_004'
  const result = registerHarness({ configDir: dir, stamp })

  assert.equal(result.skipped, false)
  assert.equal(result.configChanged, true)
  assert.equal(result.reviewerChanged, true)
  assert.equal(result.chosenModel, 'deepseek/deepseek-flash')

  const written = readFileSync(configPath, 'utf8')
  assert.match(written, /\/\/ unrelated comment must survive/)
  assert.match(written, /"nested": \[1, 2\],/)

  const { value } = parseJsonc(written)
  assert.deepEqual(value.unrelated, { keep: true, nested: [1, 2] })
  assert.equal(value.agents.researcher.model, 'deepseek/deepseek-flash')
  assert.equal(value.agents.builder.model, 'deepseek/deepseek-flash')

  const permissions = permissionSummary(value)
  assert.deepEqual(permissions[permissions.length - 1], REVIEWER_ALLOW)
  assert.equal(
    permissions.filter(
      (entry) =>
        entry.action === 'subagent' &&
        entry.resource === 'pr-reviewer' &&
        entry.effect === 'allow'
    ).length,
    1
  )

  assert.deepEqual(value.agents['pr-reviewer'].permissions, DENY_ALL)
  assert.equal(value.agents['pr-reviewer'].model, 'deepseek/deepseek-flash')
  assert.equal(value.agents['pr-reviewer'].mode, 'subagent')

  const reviewerText = readFileSync(reviewerPath, 'utf8')
  assert.match(reviewerText, /^model: deepseek\/deepseek-flash$/m)
  assert.doesNotMatch(reviewerText, /opencode\/deepseek-v4\.1-flash/)
  assert.match(reviewerText, /Body must stay intact\./)
  assert.equal(beforeReviewer.includes('Body must stay intact.'), true)

  assert.equal(existsSync(`${configPath}.bak.${stamp}`), true)
  assert.equal(existsSync(`${reviewerPath}.bak.${stamp}`), true)
})

test('idempotent: a second registration makes no writes and no duplicate allow', (t) => {
  const dir = tempConfig(t)
  const configPath = writeConfig(dir, legacyConfig())
  const reviewerPath = writeReviewer(dir)

  const first = registerHarness({ configDir: dir, stamp: '20260101_000000_001' })
  assert.equal(first.configChanged, true)
  assert.equal(first.reviewerChanged, true)

  const configAfterFirst = readFileSync(configPath, 'utf8')
  const reviewerAfterFirst = readFileSync(reviewerPath, 'utf8')
  const filesAfterFirst = readdirSync(dir).sort()

  const second = registerHarness({ configDir: dir, stamp: '20260101_000001_002' })
  assert.equal(second.configChanged, false)
  assert.equal(second.reviewerChanged, false)
  assert.equal(second.configBackup, '')
  assert.equal(second.reviewerBackup, '')

  assert.equal(readFileSync(configPath, 'utf8'), configAfterFirst)
  assert.equal(readFileSync(reviewerPath, 'utf8'), reviewerAfterFirst)
  assert.deepEqual(readdirSync(dir).sort(), filesAfterFirst)

  const { value } = parseJsonc(configAfterFirst)
  assert.equal(
    permissionSummary(value).filter(
      (entry) =>
        entry.action === 'subagent' &&
        entry.resource === 'pr-reviewer' &&
        entry.effect === 'allow'
    ).length,
    1
  )
})

test('object trailing // comment: comma follows the value, entry stays outside the comment', () => {
  for (const comma of [false, true]) {
    const first = applyHarnessRegistration({
      configText: trailingCommentObjectConfig({ comma })
    })
    assert.equal(first.configChanged, true)

    const { value } = parseJsonc(first.configText)
    assert.deepEqual(value.unrelated, { keep: true })
    assert.deepEqual(value.agents['pr-reviewer'].permissions, DENY_ALL)
    assert.match(first.configText, /\/\/ reviewer object trailing comment/)
    assert.doesNotMatch(first.configText, /\/\/ reviewer object trailing comment,/)
    assert.match(
      first.configText,
      /"model": "deepseek\/deepseek-flash", \/\/ reviewer object trailing comment/
    )

    const second = applyHarnessRegistration({ configText: first.configText })
    assert.equal(second.configChanged, false)
    assert.equal(second.configText, first.configText)
  }
})

test('array trailing // comment: comma follows the value, entry stays outside the comment', () => {
  for (const comma of [false, true]) {
    const first = applyHarnessRegistration({
      configText: trailingCommentArrayConfig({ comma })
    })
    assert.equal(first.configChanged, true)

    const { value } = parseJsonc(first.configText)
    assert.deepEqual(value.unrelated, { keep: true })
    const permissions = permissionSummary(value)
    assert.deepEqual(permissions[permissions.length - 1], REVIEWER_ALLOW)
    assert.match(first.configText, /\/\/ architect array trailing comment/)
    assert.doesNotMatch(first.configText, /\/\/ architect array trailing comment,/)
    assert.match(
      first.configText,
      /"effect": "deny" }, \/\/ architect array trailing comment/
    )

    const second = applyHarnessRegistration({ configText: first.configText })
    assert.equal(second.configChanged, false)
    assert.equal(second.configText, first.configText)
  }
})

test('allowlist order: a trailing specific deny is repaired with an allow LAST', (t) => {
  const dir = tempConfig(t)
  const config = legacyConfig({ reviewer: true, includeReviewerAllow: true })
    // Put an explicit deny after the existing allow to model order-sensitive
    // legacy permissions where the last matching rule wins.
    .replace(
      '        { "action": "subagent", "resource": "pr-reviewer", "effect": "allow" },',
      '        { "action": "subagent", "resource": "pr-reviewer", "effect": "allow" },\n' +
        '        { "action": "subagent", "resource": "pr-reviewer", "effect": "deny" },'
    )
  writeConfig(dir, config)
  writeReviewer(dir)

  const result = registerHarness({ configDir: dir, stamp: '20260101_000002_003' })
  assert.equal(result.configChanged, true)

  const { value } = parseJsonc(readFileSync(join(dir, 'opencode.json'), 'utf8'))
  const permissions = permissionSummary(value)
  assert.deepEqual(permissions[permissions.length - 1], REVIEWER_ALLOW)
})

test('model resolution: configured reviewer model is preserved', (t) => {
  const dir = tempConfig(t)
  const config = legacyConfig({ reviewer: true }).replace(
    '"pr-reviewer": {\n      "mode": "subagent",\n      "model": "deepseek/deepseek-flash",',
    '"pr-reviewer": {\n      "mode": "subagent",\n      "model": "openai/gpt-6.1-sol",'
  )
  writeConfig(dir, config)
  const reviewerPath = writeReviewer(dir)

  const result = registerHarness({ configDir: dir, stamp: '20260101_000003_004' })
  assert.equal(result.chosenModel, 'openai/gpt-6.1-sol')

  const { value } = parseJsonc(readFileSync(join(dir, 'opencode.json'), 'utf8'))
  assert.equal(value.agents['pr-reviewer'].model, 'openai/gpt-6.1-sol')
  assert.match(readFileSync(reviewerPath, 'utf8'), /^model: openai\/gpt-6\.1-sol$/m)
})

test('model resolution: builder model is used when researcher is absent', (t) => {
  const dir = tempConfig(t)
  const config = legacyConfig().replace(
    '    "researcher": { "model": "deepseek/deepseek-flash" },\n',
    ''
  )
  writeConfig(dir, config)
  writeReviewer(dir)

  const result = registerHarness({ configDir: dir, stamp: '20260101_000004_005' })
  assert.equal(result.chosenModel, 'deepseek/deepseek-flash')

  const { value } = parseJsonc(readFileSync(join(dir, 'opencode.json'), 'utf8'))
  assert.equal(value.agents['pr-reviewer'].model, 'deepseek/deepseek-flash')
})

test('no configured model: reviewer stays model-free and frontmatter is untouched', (t) => {
  const dir = tempConfig(t)
  const config = legacyConfig()
    .replace('    "researcher": { "model": "deepseek/deepseek-flash" },\n', '')
    .replace('    "builder": { "model": "deepseek/deepseek-flash" },\n', '')
  writeConfig(dir, config)
  const reviewerPath = writeReviewer(dir)
  const before = readFileSync(reviewerPath, 'utf8')

  const result = registerHarness({ configDir: dir, stamp: '20260101_000005_006' })
  assert.equal(result.chosenModel, '')
  assert.equal(result.reviewerChanged, false)
  assert.equal(readFileSync(reviewerPath, 'utf8'), before)

  const { value } = parseJsonc(readFileSync(join(dir, 'opencode.json'), 'utf8'))
  assert.equal(value.agents['pr-reviewer'].model, undefined)
  assert.deepEqual(value.agents['pr-reviewer'].permissions, DENY_ALL)
})

test('parse failure aborts with no writes and no backup', (t) => {
  const dir = tempConfig(t)
  const invalid = '{\n  "agents": {\n    "hivemind-architect": { "permissions": [ }\n  }\n}\n'
  const configPath = writeConfig(dir, invalid)
  const reviewerPath = writeReviewer(dir)
  const reviewerBefore = readFileSync(reviewerPath, 'utf8')

  assert.throws(
    () => registerHarness({ configDir: dir, stamp: '20260101_000006_007' }),
    (error) => error instanceof JsoncParseError
  )

  assert.equal(readFileSync(configPath, 'utf8'), invalid)
  assert.equal(readFileSync(reviewerPath, 'utf8'), reviewerBefore)
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.includes('.bak.')),
    []
  )
})

test('malicious invalid JSONC fails before any write or backup', (t) => {
  const dir = tempConfig(t)
  const invalid = [
    '{',
    '  "agents": {',
    '    "hivemind-architect": {',
    '      "permissions": [',
    '        { "action": "subagent", "resource": "pr-reviewer", "effect": "deny" } // },{ "malicious": true',
    '      ]',
    '    }',
    '  }'
  ].join('\n')
  const configPath = writeConfig(dir, invalid)
  const reviewerPath = writeReviewer(dir)
  const reviewerBefore = readFileSync(reviewerPath, 'utf8')

  assert.throws(
    () => registerHarness({ configDir: dir, stamp: '20260101_000007_008' }),
    (error) => error instanceof JsoncParseError
  )

  assert.equal(readFileSync(configPath, 'utf8'), invalid)
  assert.equal(readFileSync(reviewerPath, 'utf8'), reviewerBefore)
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.includes('.bak.')),
    []
  )
})

test('pure applyHarnessRegistration does not write and preserves comments', () => {
  const text = legacyConfig()
  const result = applyHarnessRegistration({
    configText: text,
    reviewerText: '---\nmode: subagent\nmodel: opencode/deepseek-v4.1-flash\n---\n'
  })
  assert.equal(result.configChanged, true)
  assert.equal(result.reviewerChanged, true)
  assert.match(result.configText, /\/\/ unrelated comment must survive/)
  assert.match(result.reviewerText, /^model: deepseek\/deepseek-flash$/m)
})

test('CLI registers an isolated temp config dir and is idempotent', (t) => {
  const dir = tempConfig(t)
  writeConfig(dir, legacyConfig())
  writeReviewer(dir)

  const first = execFileSync(
    process.execPath,
    [HELPER, '--config-dir', dir, '--json'],
    { encoding: 'utf8' }
  )
  const firstJson = JSON.parse(first.trim())
  assert.equal(firstJson.skipped, false)
  assert.equal(firstJson.configChanged, true)
  assert.equal(firstJson.reviewerChanged, true)

  const second = execFileSync(
    process.execPath,
    [HELPER, '--config-dir', dir, '--json'],
    { encoding: 'utf8' }
  )
  const secondJson = JSON.parse(second.trim())
  assert.equal(secondJson.configChanged, false)
  assert.equal(secondJson.reviewerChanged, false)

  const { value } = parseJsonc(readFileSync(join(dir, 'opencode.json'), 'utf8'))
  assert.equal(value.agents['pr-reviewer'].model, 'deepseek/deepseek-flash')
  assert.match(readFileSync(join(dir, 'agents', 'pr-reviewer.md'), 'utf8'), /^model: deepseek\/deepseek-flash$/m)
})

test('missing opencode.json is a clean no-op', (t) => {
  const dir = tempConfig(t)
  const result = registerHarness({ configDir: dir })
  assert.equal(result.skipped, true)
  assert.equal(result.configChanged, false)
  assert.equal(result.reviewerChanged, false)
})
