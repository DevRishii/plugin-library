#!/usr/bin/env node
/**
 * Unit tests for the intent-alignment evaluator and the review synthesizer.
 * Run with: node --test plugins/pr-review/test/synthesize.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ContractError, ERROR_CODES } from '../src/contracts.mjs'
import { evaluateIntentAlignment } from '../src/intent.mjs'
import {
  verifyFindingEvidence,
  deduplicateFindings,
  computeOverallVerdict,
  synthesizeReview
} from '../src/synthesize.mjs'

const SHA = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const OTHER_SHA = 'c'.repeat(40)

const AUTH_FILE = 'src/auth/token-refresh.mjs'
const BILLING_FILE = 'src/billing/invoice-export.mjs'
const BYPASS_FILE = 'src/auth/bypass.mjs'

function fileEntry(path, overrides = {}) {
  return {
    path,
    status: 'modified',
    additions: 1,
    deletions: 0,
    anchorable_new_lines: [],
    anchorable_old_lines: [],
    ...overrides
  }
}

function hunk(path, lines, overrides = {}) {
  return {
    path,
    old_start: 1,
    old_lines: 1,
    new_start: 1,
    new_lines: lines.length,
    lines,
    ...overrides
  }
}

function makePacket(overrides = {}) {
  return {
    schema_version: 1,
    pr_ref: {
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      canonical_url: 'https://github.com/acme/widgets/pull/7',
      short_ref: 'acme/widgets#7'
    },
    pr_meta: { head_sha: SHA, base_sha: BASE, title: 'Example change', body: '' },
    files: [],
    hunks: [],
    selected_lenses: [
      { id: 'intent-alignment', reason: 'core_always_on' },
      { id: 'security', reason: 'core_always_on' },
      { id: 'data-race-conditions', reason: 'core_always_on' }
    ],
    waves: [['intent-alignment', 'security', 'data-race-conditions']],
    stated_intent: { has_problem_statement: false, has_solution: false, claims: [] },
    ...overrides
  }
}

const AUTH_LINES = [
  { type: 'context', old_line: 1, new_line: 1, content: 'export function refresh() {' },
  { type: 'add', old_line: null, new_line: 2, content: '  return scheduleTokenRefresh()' },
  { type: 'context', old_line: 2, new_line: 3, content: '}' }
]

function authPacket(overrides = {}) {
  return makePacket({
    pr_meta: {
      head_sha: SHA,
      base_sha: BASE,
      title: 'Refresh auth tokens on expiry',
      body: '## Problem Statement\nAuth tokens expire silently.\n\n## Solution\nRefresh tokens on expiry.'
    },
    files: [fileEntry(AUTH_FILE, { anchorable_new_lines: [1, 2, 3], anchorable_old_lines: [1, 2] })],
    hunks: [hunk(AUTH_FILE, AUTH_LINES)],
    stated_intent: {
      has_problem_statement: true,
      has_solution: true,
      claims: [{ claim_id: 'c1', text: 'Refresh auth tokens on expiry' }]
    },
    ...overrides
  })
}

function partialPacket(overrides = {}) {
  return makePacket({
    pr_meta: {
      head_sha: SHA,
      base_sha: BASE,
      title: 'Refresh auth tokens',
      body: '## Problem Statement\nAuth tokens expire silently.'
    },
    files: [
      fileEntry(AUTH_FILE, { anchorable_new_lines: [1, 2, 3] }),
      fileEntry(BILLING_FILE, { anchorable_new_lines: [1, 2] })
    ],
    hunks: [
      hunk(AUTH_FILE, AUTH_LINES),
      hunk(BILLING_FILE, [
        { type: 'add', old_line: null, new_line: 1, content: 'export function exportInvoice() {}' },
        { type: 'add', old_line: null, new_line: 2, content: 'export const INVOICE_FORMAT = "pdf"' }
      ])
    ],
    stated_intent: {
      has_problem_statement: true,
      has_solution: false,
      claims: [{ claim_id: 'c1', text: 'Refresh auth tokens' }]
    },
    ...overrides
  })
}

function misalignedPacket(overrides = {}) {
  return makePacket({
    pr_meta: {
      head_sha: SHA,
      base_sha: BASE,
      title: 'Remove legacy auth bypass',
      body: '## Problem Statement\nA legacy auth bypass exists.\n\n## Solution\nRemove it and add audit logging to the admin panel.'
    },
    files: [fileEntry(BYPASS_FILE, { anchorable_new_lines: [1, 2] })],
    hunks: [
      hunk(BYPASS_FILE, [
        { type: 'context', old_line: 1, new_line: 1, content: 'export const legacyAuthBypass = false' },
        { type: 'add', old_line: null, new_line: 2, content: 'const legacyAuthBypass = true' }
      ])
    ],
    stated_intent: {
      has_problem_statement: true,
      has_solution: true,
      claims: [
        { claim_id: 'c1', text: 'Remove legacy auth bypass' },
        { claim_id: 'c2', text: 'Add audit logging to admin panel' }
      ]
    },
    ...overrides
  })
}

function undeterminablePacket(overrides = {}) {
  return makePacket({
    pr_meta: { head_sha: SHA, base_sha: BASE, title: '', body: '' },
    files: [fileEntry(AUTH_FILE, { anchorable_new_lines: [1, 2, 3] })],
    hunks: [hunk(AUTH_FILE, AUTH_LINES)],
    stated_intent: { has_problem_statement: false, has_solution: false, claims: [] },
    ...overrides
  })
}

function finding(overrides = {}) {
  return {
    lens_id: 'security',
    severity: 'BLOCKER',
    confidence: 'HIGH',
    path: AUTH_FILE,
    line_start: 2,
    line_end: 2,
    side: 'RIGHT',
    title: 'Refresh can double-schedule',
    body: 'The refresh path can schedule twice when two callers race.',
    evidence_quote: 'return scheduleTokenRefresh()',
    ...overrides
  }
}

function report(overrides = {}) {
  return {
    schema_version: 1,
    lens_id: 'security',
    head_sha: SHA,
    findings: [],
    ...overrides
  }
}

function alignedIntentReport(overrides = {}) {
  return report({
    lens_id: 'intent-alignment',
    intent_alignment: {
      verdict: 'ALIGNED',
      has_problem_statement: true,
      has_solution: true,
      claim_mappings: [
        { claim_id: 'c1', claim: 'Refresh auth tokens on expiry', status: 'covered', matched_files: [AUTH_FILE] }
      ],
      scope_creep_files: [],
      unfulfilled_claims: [],
      summary: 'Stated claim maps to the auth token refresh diff.'
    },
    ...overrides
  })
}

function intentReportWith(intentAlignment) {
  return report({ lens_id: 'intent-alignment', intent_alignment: intentAlignment })
}

// All three selected lenses covered exactly once, with specialist intent data.
function completeReports(overrides = {}) {
  return [
    alignedIntentReport(overrides.intent),
    report({ lens_id: 'security', findings: overrides.securityFindings ?? [] }),
    report({ lens_id: 'data-race-conditions' })
  ]
}

test('evaluateIntentAlignment: ALIGNED when claims map to changed files and both sections exist', () => {
  const intent = evaluateIntentAlignment(authPacket())
  assert.equal(intent.verdict, 'ALIGNED')
  assert.equal(intent.has_problem_statement, true)
  assert.equal(intent.has_solution, true)
  assert.equal(intent.claim_mappings.length, 1)
  assert.equal(intent.claim_mappings[0].status, 'covered')
  assert.deepEqual(intent.claim_mappings[0].matched_files, [AUTH_FILE])
  assert.deepEqual(intent.scope_creep_files, [])
  assert.deepEqual(intent.unfulfilled_claims, [])
})

test('evaluateIntentAlignment: PARTIAL on scope creep plus a missing Solution section', () => {
  const intent = evaluateIntentAlignment(partialPacket())
  assert.equal(intent.verdict, 'PARTIAL')
  assert.equal(intent.has_problem_statement, true)
  assert.equal(intent.has_solution, false)
  assert.deepEqual(intent.scope_creep_files, [BILLING_FILE])
  assert.equal(intent.claim_mappings[0].status, 'covered')
  assert.match(intent.summary, /PARTIAL/)
})

test('evaluateIntentAlignment: MISALIGNED on a contradicted claim and an unfulfilled claim', () => {
  const intent = evaluateIntentAlignment(misalignedPacket())
  assert.equal(intent.verdict, 'MISALIGNED')
  assert.equal(intent.claim_mappings.length, 2)
  assert.equal(intent.claim_mappings[0].status, 'contradicted')
  assert.equal(intent.claim_mappings[1].status, 'unfulfilled')
  assert.equal(intent.unfulfilled_claims.length, 2)
  assert.deepEqual(intent.scope_creep_files, [])
})

test('evaluateIntentAlignment: UNDETERMINABLE on blank title and body', () => {
  const intent = evaluateIntentAlignment(undeterminablePacket())
  assert.equal(intent.verdict, 'UNDETERMINABLE')
  assert.deepEqual(intent.claim_mappings, [])
  assert.deepEqual(intent.scope_creep_files, [])
  assert.deepEqual(intent.unfulfilled_claims, [])
})

test('evaluateIntentAlignment: hallucinated override paths are stripped and real creep survives', () => {
  const override = {
    claim_mappings: [
      {
        claim_id: 'c1',
        claim: 'Refresh auth tokens',
        status: 'covered',
        matched_files: [AUTH_FILE, 'src/ghost/hallucinated.mjs']
      }
    ],
    scope_creep_files: [BILLING_FILE, 'src/ghost/hallucinated.mjs']
  }
  const intent = evaluateIntentAlignment(partialPacket(), override)
  assert.equal(intent.claim_mappings[0].matched_files.length, 1)
  assert.deepEqual(intent.claim_mappings[0].matched_files, [AUTH_FILE])
  assert.deepEqual(intent.scope_creep_files, [BILLING_FILE])
  assert.equal(intent.verdict, 'PARTIAL')
})

test('verifyFindingEvidence: valid anchor plus verbatim quote verifies the finding', () => {
  const result = verifyFindingEvidence(authPacket(), finding())
  assert.equal(result.verified, true)
  assert.equal(result.anchorable, true)
  assert.equal(result.file_in_diff, true)
  assert.equal(result.demote_reason, null)
  assert.equal(result.normalized_finding.verified, true)
  assert.equal(result.normalized_finding.anchorable, true)
})

test('verifyFindingEvidence: a line outside the hunk demotes BLOCKER to MEDIUM', () => {
  const result = verifyFindingEvidence(authPacket(), finding({ line_start: 99, line_end: 99 }))
  assert.equal(result.verified, false)
  assert.equal(result.anchorable, false)
  assert.equal(result.file_in_diff, true)
  assert.equal(result.demote_reason, 'line_not_anchorable')
  assert.equal(result.normalized_finding.severity, 'MEDIUM')
})

test('verifyFindingEvidence: mismatched quote is a demotion, never a verification', () => {
  const result = verifyFindingEvidence(authPacket(), finding({ evidence_quote: 'a line that never existed in the diff()' }))
  assert.equal(result.verified, false)
  assert.equal(result.file_in_diff, true)
  assert.equal(result.demote_reason, 'quote_mismatch')
  assert.equal(result.normalized_finding.severity, 'MEDIUM')
})

test('deduplicateFindings: merges corroborating lenses and upgrades confidence', () => {
  const base = {
    path: AUTH_FILE,
    side: 'RIGHT',
    title: 'Unfenced release after await',
    evidence_quote: 'if (!lock) throw new Error(RELEASE)',
    verified: true,
    anchorable: true
  }
  const entries = [
    {
      verified: true,
      anchorable: true,
      file_in_diff: true,
      demote_reason: null,
      normalized_finding: {
        ...base,
        lens_id: 'security',
        severity: 'HIGH',
        confidence: 'MEDIUM',
        line_start: 10,
        line_end: 11,
        body: 'The release path can run twice when two workers pass the check before release.'
      }
    },
    {
      verified: true,
      anchorable: true,
      file_in_diff: true,
      demote_reason: null,
      normalized_finding: {
        ...base,
        lens_id: 'data-race-conditions',
        severity: 'MEDIUM',
        confidence: 'MEDIUM',
        line_start: 12,
        line_end: 13,
        body: 'Two workers can both pass the check and release the lock after the await.'
      }
    }
  ]

  const merged = deduplicateFindings(entries)
  assert.equal(merged.length, 1)
  const canonical = merged[0].normalized_finding
  assert.equal(canonical.severity, 'HIGH')
  assert.equal(canonical.confidence, 'HIGH')
  assert.deepEqual(canonical.corroborating_lenses, ['data-race-conditions', 'security'])
  assert.equal(merged[0].anchorable, true)
  assert.equal(canonical.line_start, 10)
  assert.equal(canonical.line_end, 13)
})

test('computeOverallVerdict: verified blockers and any intact HIGH request changes', () => {
  const intent = { verdict: 'ALIGNED' }
  assert.equal(computeOverallVerdict([finding({ verified: true })], intent), 'REQUEST_CHANGES')
  assert.equal(
    computeOverallVerdict([finding({ verified: true, severity: 'HIGH', confidence: 'MEDIUM' })], intent),
    'REQUEST_CHANGES'
  )
  assert.equal(
    computeOverallVerdict([finding({ verified: true, severity: 'HIGH', confidence: 'LOW' })], intent),
    'REQUEST_CHANGES'
  )
})

test('computeOverallVerdict: intact MEDIUM blocks approval without strictApprove', () => {
  const intent = { verdict: 'ALIGNED' }
  assert.equal(
    computeOverallVerdict([finding({ verified: true, severity: 'MEDIUM', confidence: 'HIGH' })], intent),
    'COMMENT'
  )
  assert.equal(
    computeOverallVerdict([finding({ verified: true, severity: 'LOW', confidence: 'HIGH' })], intent),
    'APPROVE'
  )
  assert.equal(
    computeOverallVerdict([finding({ verified: true, severity: 'NIT', confidence: 'LOW' })], intent),
    'APPROVE'
  )
})

test('computeOverallVerdict: missing coverage or intent report cannot approve', () => {
  const intent = { verdict: 'ALIGNED' }
  assert.equal(computeOverallVerdict([], intent, { completeCoverage: false, hasIntentReport: true }), 'COMMENT')
  assert.equal(computeOverallVerdict([], intent, { completeCoverage: true, hasIntentReport: false }), 'COMMENT')
  assert.equal(computeOverallVerdict([], intent, { completeCoverage: true, hasIntentReport: true }), 'APPROVE')
})

test('synthesizeReview: complete unique reports with ALIGNED intent yield APPROVE', () => {
  const payload = synthesizeReview(authPacket(), completeReports(), { renderMarkdown: (draft) => `# ${draft.verdict}` })
  assert.equal(payload.verdict, 'APPROVE')
  assert.equal(payload.intent.verdict, 'ALIGNED')
  assert.deepEqual(payload.inline_comments, [])
  assert.deepEqual(payload.summary_findings, [])
  assert.equal(payload.markdown_body, '# APPROVE')
  assert.equal(payload.lens_coverage.length, 3)
  assert.equal(payload.lens_coverage.every((entry) => entry.status === 'completed' && entry.report_count === 1), true)
  assert.equal(payload.stats.selected_lenses, 3)
  assert.equal(payload.stats.subagent_reports, 3)
  assert.equal(payload.stats.dropped_hallucinated_path, 0)
})

test('synthesizeReview: missing intent report is UNDETERMINABLE and can never APPROVE', () => {
  const payload = synthesizeReview(authPacket(), [
    report({ lens_id: 'security' }),
    report({ lens_id: 'data-race-conditions' })
  ])
  assert.equal(payload.intent.verdict, 'UNDETERMINABLE')
  assert.equal(payload.verdict, 'COMMENT')
  const intentCoverage = payload.lens_coverage.find((entry) => entry.lens_id === 'intent-alignment')
  assert.equal(intentCoverage.status, 'missing')
  assert.equal(intentCoverage.report_count, 0)
})

test('synthesizeReview: empty report list yields COMMENT with visible missing coverage', () => {
  const payload = synthesizeReview(authPacket(), [])
  assert.equal(payload.intent.verdict, 'UNDETERMINABLE')
  assert.equal(payload.verdict, 'COMMENT')
  assert.equal(payload.lens_coverage.every((entry) => entry.status === 'missing'), true)
  assert.equal(payload.stats.subagent_reports, 0)
})

test('synthesizeReview: intent report without specialist data is UNDETERMINABLE', () => {
  const payload = synthesizeReview(authPacket(), [
    report({ lens_id: 'intent-alignment' }),
    report({ lens_id: 'security' }),
    report({ lens_id: 'data-race-conditions' })
  ])
  assert.equal(payload.intent.verdict, 'UNDETERMINABLE')
  assert.equal(payload.verdict, 'COMMENT')
})

test('synthesizeReview: empty object/array intent_alignment is rejected as schema invalid', () => {
  for (const malformed of [{}, []]) {
    assert.throws(
      () => synthesizeReview(authPacket(), [
        intentReportWith(malformed),
        report({ lens_id: 'security' }),
        report({ lens_id: 'data-race-conditions' })
      ]),
      (error) => error instanceof ContractError && error.code === ERROR_CODES.SCHEMA_INVALID
    )
  }
})

test('synthesizeReview: invalid verdict or missing intent fields is rejected as schema invalid', () => {
  const invalidVerdict = { ...alignedIntentReport().intent_alignment, verdict: 'MAYBE' }
  const missingFields = { verdict: 'ALIGNED' }
  const missingSummary = { ...alignedIntentReport().intent_alignment, summary: '   ' }
  for (const malformed of [invalidVerdict, missingFields, missingSummary]) {
    assert.throws(
      () => synthesizeReview(authPacket(), [
        intentReportWith(malformed),
        report({ lens_id: 'security' }),
        report({ lens_id: 'data-race-conditions' })
      ]),
      (error) => error instanceof ContractError && error.code === ERROR_CODES.SCHEMA_INVALID
    )
  }
})

test('synthesizeReview: PARTIAL and UNDETERMINABLE specialist intent can never APPROVE', () => {
  const partialIntent = alignedIntentReport()
  partialIntent.intent_alignment = { ...partialIntent.intent_alignment, verdict: 'PARTIAL' }
  const partial = synthesizeReview(partialPacket(), [
    partialIntent,
    report({ lens_id: 'security' }),
    report({ lens_id: 'data-race-conditions' })
  ])
  assert.equal(partial.intent.verdict, 'PARTIAL')
  assert.equal(partial.verdict, 'COMMENT')

  const undeterminedIntent = alignedIntentReport()
  undeterminedIntent.intent_alignment = { ...undeterminedIntent.intent_alignment, verdict: 'UNDETERMINABLE' }
  const undetermined = synthesizeReview(undeterminablePacket(), [
    undeterminedIntent,
    report({ lens_id: 'security' }),
    report({ lens_id: 'data-race-conditions' })
  ])
  assert.equal(undetermined.intent.verdict, 'UNDETERMINABLE')
  assert.equal(undetermined.verdict, 'COMMENT')
})

test('synthesizeReview: duplicate reports for one lens are rejected', () => {
  assert.throws(
    () => synthesizeReview(authPacket(), [...completeReports(), report({ lens_id: 'security' })]),
    (error) => error instanceof ContractError && error.code === ERROR_CODES.SCHEMA_INVALID
  )
})

test('synthesizeReview: unselected lens reports are rejected', () => {
  assert.throws(
    () => synthesizeReview(authPacket(), [report({ lens_id: 'testing-verification' })]),
    (error) => error instanceof ContractError && error.code === ERROR_CODES.SCHEMA_INVALID
  )
})

test('synthesizeReview: a mismatched head_sha throws STALE_HEAD_SHA', () => {
  assert.throws(
    () => synthesizeReview(authPacket(), [report({ head_sha: OTHER_SHA })]),
    (error) => error instanceof ContractError && error.code === ERROR_CODES.STALE_HEAD_SHA
  )
})

test('synthesizeReview: hallucinated file paths are dropped and counted', () => {
  const payload = synthesizeReview(authPacket(), [
    report({
      findings: [finding({ path: 'src/ghost/missing.mjs', line_start: 4, line_end: 4 })]
    })
  ])
  assert.equal(payload.stats.dropped_hallucinated_path, 1)
  assert.equal(payload.stats.findings_reported, 0)
  assert.deepEqual(payload.inline_comments, [])
  assert.deepEqual(payload.summary_findings, [])
})

test('synthesizeReview: a verified blocker produces REQUEST_CHANGES and an inline comment', () => {
  const payload = synthesizeReview(authPacket(), completeReports({ securityFindings: [finding()] }))
  assert.equal(payload.verdict, 'REQUEST_CHANGES')
  assert.equal(payload.inline_comments.length, 1)
  assert.deepEqual(payload.summary_findings, [])
})

test('synthesizeReview: an unverified blocker is demoted and cannot block', () => {
  const payload = synthesizeReview(authPacket(), completeReports({
    securityFindings: [finding({ line_start: 99, line_end: 99 })]
  }))
  assert.equal(payload.verdict, 'APPROVE')
  assert.equal(payload.inline_comments.length, 0)
  assert.equal(payload.summary_findings.length, 1)
  assert.equal(payload.summary_findings[0].severity, 'MEDIUM')
  assert.equal(payload.summary_findings[0].verified, false)
  assert.equal(payload.summary_findings[0].demote_reason, 'line_not_anchorable')
})

test('synthesizeReview: an intact MEDIUM blocks approval by default', () => {
  const payload = synthesizeReview(authPacket(), completeReports({
    securityFindings: [finding({ severity: 'MEDIUM', confidence: 'HIGH' })]
  }))
  assert.equal(payload.inline_comments.length, 1)
  assert.equal(payload.inline_comments[0].severity, 'MEDIUM')
  assert.equal(payload.verdict, 'COMMENT')
})

test('synthesizeReview: an intact LOW-confidence HIGH still requests changes', () => {
  const payload = synthesizeReview(authPacket(), completeReports({
    securityFindings: [finding({ severity: 'HIGH', confidence: 'LOW' })]
  }))
  assert.equal(payload.verdict, 'REQUEST_CHANGES')
  assert.equal(payload.inline_comments.length, 1)
})