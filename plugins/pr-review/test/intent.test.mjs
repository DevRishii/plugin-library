#!/usr/bin/env node
/**
 * Unit tests for the intent-alignment evaluator's specialist-data safety gate.
 * Run with: node --test plugins/pr-review/test/intent.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateIntentAlignment } from '../src/intent.mjs'

const AUTH_FILE = 'src/auth/token-refresh.mjs'

function makePacket(overrides = {}) {
  return {
    files: [{ path: AUTH_FILE }],
    hunks: [
      {
        path: AUTH_FILE,
        lines: [
          { type: 'context', old_line: 1, new_line: 1, content: 'export function refresh() {' },
          { type: 'add', old_line: null, new_line: 2, content: '  return scheduleTokenRefresh()' },
          { type: 'context', old_line: 2, new_line: 3, content: '}' }
        ]
      }
    ],
    pr_meta: {
      title: 'Refresh auth tokens on expiry',
      body: '## Problem Statement\nAuth tokens expire silently.\n\n## Solution\nRefresh tokens on expiry.'
    },
    stated_intent: {
      has_problem_statement: true,
      has_solution: true,
      claims: [{ claim_id: 'c1', text: 'Refresh auth tokens on expiry' }]
    },
    ...overrides
  }
}

function alignedOverride() {
  return {
    verdict: 'ALIGNED',
    has_problem_statement: true,
    has_solution: true,
    claim_mappings: [
      { claim_id: 'c1', claim: 'Refresh auth tokens on expiry', status: 'covered', matched_files: [AUTH_FILE] }
    ],
    scope_creep_files: [],
    unfulfilled_claims: [],
    summary: 'Claim maps to the token refresh diff.'
  }
}

function bypassRemovalPacket() {
  return makePacket({
    files: [{ path: 'src/auth/bypass.mjs' }],
    hunks: [
      {
        path: 'src/auth/bypass.mjs',
        lines: [
          { type: 'context', old_line: 1, new_line: 1, content: 'export const legacyAuthBypass = false' },
          { type: 'add', old_line: null, new_line: 2, content: 'const legacyAuthBypass = true' }
        ]
      }
    ],
    pr_meta: {
      title: 'Remove legacy auth bypass',
      body: '## Problem Statement\nA legacy auth bypass exists.\n\n## Solution\nRemove it.'
    },
    stated_intent: {
      has_problem_statement: true,
      has_solution: true,
      claims: [{ claim_id: 'c1', text: 'Remove legacy auth bypass' }]
    }
  })
}

test('evaluateIntentAlignment: default heuristic behavior is preserved', () => {
  assert.equal(evaluateIntentAlignment(makePacket()).verdict, 'ALIGNED')
})

test('evaluateIntentAlignment: requireSpecialist without specialist data yields UNDETERMINABLE', () => {
  const intent = evaluateIntentAlignment(makePacket(), null, { requireSpecialist: true })
  assert.equal(intent.verdict, 'UNDETERMINABLE')
  assert.match(intent.summary, /UNDETERMINABLE/)
})

test('evaluateIntentAlignment: verified specialist data can still certify ALIGNED', () => {
  const intent = evaluateIntentAlignment(makePacket(), alignedOverride(), { requireSpecialist: true })
  assert.equal(intent.verdict, 'ALIGNED')
})

test('evaluateIntentAlignment: requireSpecialist keeps concrete contradictions MISALIGNED', () => {
  const intent = evaluateIntentAlignment(bypassRemovalPacket(), null, { requireSpecialist: true })
  assert.equal(intent.verdict, 'MISALIGNED')
})

test('evaluateIntentAlignment: requireSpecialist treats empty object/array and partial bodies as missing', () => {
  const malformedBodies = [
    {},
    [],
    { verdict: 'ALIGNED' },
    { ...alignedOverride(), verdict: 'MAYBE' },
    { ...alignedOverride(), summary: '   ' }
  ]
  for (const malformed of malformedBodies) {
    const intent = evaluateIntentAlignment(makePacket(), malformed, { requireSpecialist: true })
    assert.equal(intent.verdict, 'UNDETERMINABLE')
    assert.match(intent.summary, /UNDETERMINABLE/)
  }
})

test('evaluateIntentAlignment: requireSpecialist malformed specialist data cannot mask a contradiction', () => {
  for (const malformed of [{}, [], { verdict: 'ALIGNED' }]) {
    const intent = evaluateIntentAlignment(bypassRemovalPacket(), malformed, { requireSpecialist: true })
    assert.equal(intent.verdict, 'MISALIGNED')
  }
})

test('evaluateIntentAlignment: requireSpecialist needs an explicit ALIGNED specialist verdict', () => {
  const partial = evaluateIntentAlignment(makePacket(), { ...alignedOverride(), verdict: 'PARTIAL' }, { requireSpecialist: true })
  assert.equal(partial.verdict, 'PARTIAL')

  const undetermined = evaluateIntentAlignment(
    makePacket(),
    { ...alignedOverride(), verdict: 'UNDETERMINABLE' },
    { requireSpecialist: true }
  )
  assert.equal(undetermined.verdict, 'UNDETERMINABLE')
})
