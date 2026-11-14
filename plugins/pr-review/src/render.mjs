/**
 * GitHub Markdown renderers for Hivemind multi-angle PR reviews.
 *
 * Pure functions with zero third-party dependencies. Contract validation is
 * delegated to ./contracts.mjs so renderers never drift from the schema.
 */
import {
  REVIEW_MARKER,
  validateOrchestratedPRReviewPayload
} from './contracts.mjs'

function text(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim()
}

function inlineText(value) {
  return text(value).replace(/\n+/g, ' ').replace(/\|/g, '\\|')
}

function severityOf(finding) {
  return inlineText(finding?.severity) || 'NIT'
}

function lensOf(finding) {
  return inlineText(finding?.lens_id) || 'unknown-lens'
}

function scopePath(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') {
    return entry.path ?? entry.file ?? entry.name ?? ''
  }
  return ''
}

function claimText(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') {
    return entry.claim ?? entry.description ?? entry.title ?? entry.summary ?? ''
  }
  return ''
}

function countOf(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0
}

function lensIdOf(entry) {
  return inlineText(entry?.lens_id ?? entry?.lens ?? entry?.id) || 'unknown-lens'
}

function findingCountOf(entry) {
  if (typeof entry?.finding_count !== 'undefined') return countOf(entry.finding_count)
  if (typeof entry?.findings_count !== 'undefined') return countOf(entry.findings_count)
  if (typeof entry?.count !== 'undefined') return countOf(entry.count)
  if (Array.isArray(entry?.findings)) return entry.findings.length
  if (typeof entry?.findings === 'number') return countOf(entry.findings)
  return 0
}

export function renderInlineCommentBody(comment = {}) {
  const severity = severityOf(comment)
  const lens = lensOf(comment)
  const title = inlineText(comment.title) || 'Untitled finding'
  const unverified = comment?.verified === false
  const tag = unverified ? `UNVERIFIED \u00b7 ${severity} \u00b7 ${lens}` : `${severity} \u00b7 ${lens}`
  const lines = [`**[${tag}]** ${title}`]
  if (unverified) {
    lines.push('', '_Anchor/evidence not validated; not a verdict basis._')
  }

  const corroborating = Array.isArray(comment.corroborating_lenses)
    ? comment.corroborating_lenses.map((id) => inlineText(id)).filter(Boolean)
    : []
  if (corroborating.length > 1) {
    lines.push('', `Corroborated by: ${corroborating.join(', ')}`)
  }

  const body = text(comment.body)
  if (body) {
    lines.push('', body)
  }

  const suggestion = comment.suggestion == null
    ? ''
    : String(comment.suggestion).replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  if (suggestion.trim()) {
    lines.push('', '```suggestion', suggestion, '```')
  }

  return lines.join('\n')
}

export function renderReviewMarkdown(payload) {
  const review = validateOrchestratedPRReviewPayload(payload)
  const intent = review.intent
  const lines = [
    REVIEW_MARKER,
    `<!-- head_sha:${review.head_sha} -->`,
    '',
    `## Hivemind Multi-Angle PR Review \u2014 \`${review.verdict}\``,
    '',
    '### Intent vs. Code-Intent Alignment',
    '',
    `- **Intent verdict:** ${intent.verdict}`,
    `- **Problem Statement present:** ${intent.has_problem_statement ? 'yes' : 'no'}`,
    `- **Solution present:** ${intent.has_solution ? 'yes' : 'no'}`,
    '',
    text(intent.summary) || '_No intent summary provided._'
  ]

  const scopeCreep = Array.isArray(intent.scope_creep_files)
    ? intent.scope_creep_files.map(scopePath).filter(Boolean)
    : []
  lines.push('', '**Scope Creep files:**' + (scopeCreep.length ? '' : ' none'))
  for (const file of scopeCreep) {
    lines.push(`- \`${inlineText(file)}\``)
  }

  const unfulfilled = Array.isArray(intent.unfulfilled_claims)
    ? intent.unfulfilled_claims.map(claimText).filter(Boolean)
    : []
  if (unfulfilled.length > 0) {
    lines.push('', '**Unfulfilled Claims:**')
    for (const claim of unfulfilled) {
      lines.push(`- ${inlineText(claim)}`)
    }
  }

  lines.push('', '### Multi-Angle Swarm Coverage', '')
  lines.push('| Lens | Status | Findings |', '| --- | --- | --- |')
  if (review.lens_coverage.length === 0) {
    lines.push('| _none_ | \u2014 | 0 |')
  } else {
    for (const entry of review.lens_coverage) {
      const status = inlineText(entry?.status) || 'completed'
      lines.push(`| ${lensIdOf(entry)} | ${status} | ${findingCountOf(entry)} |`)
    }
  }

  lines.push(
    '',
    '> **Limited diff coverage.** A `completed` specialist report means the lens reviewed its **bounded slice**, not the entire diff. Omitted diff content is **unknown, not absent**; a missing finding is not evidence that the omitted code is clean.'
  )

  lines.push('', '### Summary & Cross-Cutting Findings', '')
  if (review.summary_findings.length === 0) {
    lines.push('_No cross-cutting summary findings._')
  } else {
    for (const finding of review.summary_findings) {
      const unverified = finding?.verified === false
      const tag = unverified
        ? `UNVERIFIED \u00b7 ${severityOf(finding)} \u00b7 ${lensOf(finding)}`
        : `${severityOf(finding)} \u00b7 ${lensOf(finding)}`
      lines.push(`- **[${tag}]** ${inlineText(finding?.title) || 'Untitled finding'}`)
      if (unverified) {
        lines.push('  _Anchor/evidence not validated; not a verdict basis._')
      }
      const body = text(finding?.body)
      if (body) {
        lines.push(`  ${body.replace(/\n/g, '\n  ')}`)
      }
    }
  }

  const anchored = review.inline_comments.filter((comment) => {
    const line = comment?.line ?? comment?.line_end
    return line !== null && typeof line !== 'undefined' && Boolean(comment?.path)
  }).length
  lines.push('', `_Inline comments anchored directly on diff lines: ${anchored} of ${review.inline_comments.length}._`)

  const deduplicated = countOf(
    review.stats?.deduplicated_merged
      ?? review.stats?.findings_deduped
      ?? review.audit?.deduplicated_count
      ?? review.deduplicated_count
  )
  const rawFindings = countOf(
    review.stats?.raw_findings
      ?? review.stats?.findings_total
      ?? review.audit?.raw_findings_count
      ?? review.raw_findings_count
      ?? (review.inline_comments.length + review.summary_findings.length + deduplicated)
  )
  lines.push(
    '',
    `_Synthesis audit \u2014 head_sha: \`${review.head_sha}\` \u00b7 raw findings: ${rawFindings} \u2192 verified inline: ${review.inline_comments.length} \u00b7 summary: ${review.summary_findings.length} \u00b7 deduplicated: ${deduplicated}_`
  )

  return `${lines.join('\n')}\n`
}

export function buildGitHubReviewApiBody(payload, eventOverride = null) {
  const review = validateOrchestratedPRReviewPayload(payload)
  return {
    commit_id: review.head_sha,
    event: eventOverride ?? review.verdict,
    body: review.markdown_body || renderReviewMarkdown(review),
    comments: review.inline_comments.map((comment) => {
      const line = comment.line ?? comment.line_end
      return {
        path: comment.path,
        line,
        ...(comment.start_line && comment.start_line < line
          ? { start_line: comment.start_line, start_side: comment.side ?? 'RIGHT' }
          : {}),
        side: comment.side ?? 'RIGHT',
        body: renderInlineCommentBody(comment)
      }
    })
  }
}