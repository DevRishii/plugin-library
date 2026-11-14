import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ContractError,
  ERROR_CODES,
  EXIT_CODES,
  SCHEMA_VERSION,
  validateOrchestratedPRReviewPayload,
  validateSubagentReviewReport
} from '../src/contracts.mjs'

const HEAD_SHA = 'a'.repeat(40)

function makeIntent(overrides = {}) {
  return {
    verdict: 'ALIGNED',
    has_problem_statement: true,
    has_solution: true,
    claim_mappings: [
      {
        claim_id: 'c1',
        claim: 'Publish reviews through GitHub.',
        status: 'covered',
        matched_files: ['src/runner.mjs']
      }
    ],
    scope_creep_files: [],
    unfulfilled_claims: [],
    summary: 'The diff fulfills the stated Problem Statement and Solution.',
    ...overrides
  }
}

function makeFinding(severity, overrides = {}) {
  return {
    lens_id: 'security',
    severity,
    confidence: 'HIGH',
    path: 'src/runner.mjs',
    line_start: 1,
    line_end: 1,
    side: 'RIGHT',
    title: `${severity} legacy finding`,
    body: 'A legacy APPROVE artifact retained this finding.',
    evidence_quote: 'export const runner = true',
    ...overrides
  }
}

function makeIntentReport(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    lens_id: 'intent-alignment',
    head_sha: HEAD_SHA,
    findings: [],
    summary: 'Intent alignment specialist report.',
    intent_alignment: makeIntent(),
    ...overrides
  }
}

function completed(lensId, overrides = {}) {
  return {
    lens_id: lensId,
    status: 'completed',
    reviewed: true,
    report_count: 1,
    finding_count: 0,
    ...overrides
  }
}

function makeApprovePayload(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    pr_ref: {
      canonical_url: 'https://github.com/acme/widgets/pull/7',
      short_ref: 'acme/widgets#7',
      owner: 'acme',
      repo: 'widgets',
      number: 7
    },
    head_sha: HEAD_SHA,
    verdict: 'APPROVE',
    intent: makeIntent(),
    inline_comments: [],
    summary_findings: [],
    lens_coverage: [completed('intent-alignment'), completed('security')],
    stats: { subagent_reports: 2, selected_lenses: 2 },
    ...overrides
  }
}

function isValidationError(error) {
  return error instanceof ContractError
    && error.code === ERROR_CODES.SCHEMA_INVALID
    && error.exitCode === EXIT_CODES.VALIDATION
}

test('valid APPROVE payload with complete unique reviewed coverage is accepted', () => {
  const payload = makeApprovePayload()
  assert.equal(validateOrchestratedPRReviewPayload(payload), payload)
})

test('legacy zero-report APPROVE payload is rejected', () => {
  assert.throws(
    () => validateOrchestratedPRReviewPayload(makeApprovePayload({
      lens_coverage: [],
      stats: { subagent_reports: 0, selected_lenses: 0 }
    })),
    isValidationError
  )
})

test('APPROVE with incomplete or unreviewed coverage is rejected', () => {
  const cases = [
    makeApprovePayload({
      lens_coverage: [
        completed('intent-alignment'),
        completed('security', { status: 'missing', reviewed: false, report_count: 0 })
      ]
    }),
    makeApprovePayload({
      lens_coverage: [
        completed('intent-alignment'),
        completed('security', { reviewed: false })
      ]
    }),
    makeApprovePayload({
      lens_coverage: [
        completed('intent-alignment'),
        completed('security', { report_count: 0 })
      ]
    }),
    makeApprovePayload({
      lens_coverage: [completed('security')]
    }),
    makeApprovePayload({
      lens_coverage: [completed('intent-alignment'), completed('intent-alignment')],
      stats: { subagent_reports: 2, selected_lenses: 2 }
    })
  ]
  for (const payload of cases) {
    assert.throws(() => validateOrchestratedPRReviewPayload(payload), isValidationError)
  }
})

test('APPROVE with mismatched stats is rejected', () => {
  assert.throws(
    () => validateOrchestratedPRReviewPayload(makeApprovePayload({
      stats: { subagent_reports: 1, selected_lenses: 2 }
    })),
    isValidationError
  )
  assert.throws(
    () => validateOrchestratedPRReviewPayload(makeApprovePayload({
      stats: { subagent_reports: 2, selected_lenses: 3 }
    })),
    isValidationError
  )
})

test('non-ALIGNED intent can never APPROVE', () => {
  assert.throws(
    () => validateOrchestratedPRReviewPayload(makeApprovePayload({
      intent: makeIntent({ verdict: 'PARTIAL' })
    })),
    isValidationError
  )
  assert.throws(
    () => validateOrchestratedPRReviewPayload(makeApprovePayload({
      intent: makeIntent({ verdict: 'UNDETERMINABLE' })
    })),
    isValidationError
  )
})

test('explicit finding lens mismatch inside a report is rejected', () => {
  const report = {
    schema_version: SCHEMA_VERSION,
    lens_id: 'security',
    head_sha: HEAD_SHA,
    findings: [
      {
        lens_id: 'data-race-conditions',
        severity: 'LOW',
        confidence: 'HIGH',
        path: 'src/runner.mjs',
        line_start: 1,
        line_end: 1,
        side: 'RIGHT',
        title: 'Mismatched lens provenance',
        body: 'This finding claims to come from a different report lens.',
        evidence_quote: 'export const runner = true'
      }
    ]
  }
  assert.throws(() => validateSubagentReviewReport(report), isValidationError)
})

test('findings inheriting their report lens remain valid', () => {
  const report = validateSubagentReviewReport({
    schema_version: SCHEMA_VERSION,
    lens_id: 'security',
    head_sha: HEAD_SHA,
    findings: [
      {
        severity: 'LOW',
        confidence: 'HIGH',
        path: 'src/runner.mjs',
        line_start: 1,
        line_end: 1,
        side: 'RIGHT',
        title: 'Inherited lens provenance',
        body: 'Finding omits lens_id and inherits the report lens.',
        evidence_quote: 'export const runner = true'
      }
    ]
  })
  assert.equal(report.findings[0].lens_id, 'security')
})

test('APPROVE rejects intact MEDIUM/HIGH/BLOCKER findings in inline and summary arrays', () => {
  for (const severity of ['MEDIUM', 'HIGH', 'BLOCKER']) {
    assert.throws(
      () => validateOrchestratedPRReviewPayload(makeApprovePayload({
        inline_comments: [makeFinding(severity)]
      })),
      isValidationError,
      `APPROVE must reject an inline ${severity} finding`
    )
    assert.throws(
      () => validateOrchestratedPRReviewPayload(makeApprovePayload({
        summary_findings: [makeFinding(severity)]
      })),
      isValidationError,
      `APPROVE must reject a summary ${severity} finding`
    )
  }
})

test('APPROVE ignores verified:false severe findings but still allows LOW/NIT findings', () => {
  const payload = makeApprovePayload({
    inline_comments: [makeFinding('BLOCKER', { verified: false })],
    summary_findings: [
      makeFinding('HIGH', { verified: false }),
      makeFinding('MEDIUM', { verified: false }),
      makeFinding('LOW'),
      makeFinding('NIT')
    ]
  })
  assert.equal(validateOrchestratedPRReviewPayload(payload), payload)
})

test('intent-alignment specialist report accepts a full IntentAlignmentReport', () => {
  const report = validateSubagentReviewReport(makeIntentReport())
  assert.equal(report.lens_id, 'intent-alignment')
  assert.equal(report.intent_alignment.verdict, 'ALIGNED')
  assert.deepEqual(report.intent_alignment.claim_mappings, makeIntent().claim_mappings)
})

test('provided report.intent_alignment must validate as a full IntentAlignmentReport', () => {
  const malformedIntents = [
    makeIntent({ verdict: 'BOGUS' }),
    makeIntent({ verdict: undefined }),
    makeIntent({ has_problem_statement: 'yes' }),
    makeIntent({ has_solution: undefined }),
    makeIntent({ claim_mappings: null }),
    makeIntent({ scope_creep_files: 'src/unrelated.mjs' }),
    makeIntent({ unfulfilled_claims: null }),
    makeIntent({ summary: '   ' }),
    makeIntent({ summary: undefined })
  ]
  for (const intent_alignment of malformedIntents) {
    assert.throws(
      () => validateSubagentReviewReport(makeIntentReport({ intent_alignment })),
      isValidationError
    )
  }
})

test('only the intent-alignment specialist report may carry intent_alignment', () => {
  assert.throws(
    () => validateSubagentReviewReport(makeIntentReport({ lens_id: 'security' })),
    isValidationError
  )
})
