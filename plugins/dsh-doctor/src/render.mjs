const COLUMNS = [
  { key: 'status', title: 'STATUS' },
  { key: 'severity', title: 'SEVERITY' },
  { key: 'group', title: 'GROUP' },
  { key: 'id', title: 'CHECK' },
  { key: 'summary', title: 'SUMMARY' },
];

/**
 * Render findings as an aligned text table.
 *
 * @param {object[]} findings Findings in report order.
 * @returns {string} Table text without a trailing newline.
 */
export function renderTable(findings) {
  const rows = findings.map((finding) => ({
    status: finding.status.toUpperCase(),
    severity: finding.severity,
    group: finding.group,
    id: finding.id,
    summary: finding.summary,
  }));
  const widths = COLUMNS.map((column) =>
    Math.max(column.title.length, ...rows.map((row) => String(row[column.key]).length)),
  );
  const format = (row) =>
    COLUMNS.map((column, index) => String(row[column.key]).padEnd(widths[index])).join('  ').trimEnd();
  return [format(Object.fromEntries(COLUMNS.map((column) => [column.key, column.title]))), ...rows.map(format)].join('\n');
}

/**
 * Render the evidence and fix blocks that follow the table.
 *
 * @param {object[]} findings Findings carrying evidence and fixes.
 * @returns {string} Detail text, empty when nothing needs explaining.
 */
export function renderDetails(findings) {
  const blocks = [];
  for (const finding of findings) {
    if (finding.status === 'pass') continue;
    if (finding.status === 'skip' && finding.evidence.length === 0) continue;
    const lines = [`${finding.status.toUpperCase()} ${finding.id} — ${finding.title}`];
    lines.push(`  ${finding.summary}`);
    for (const item of finding.evidence) {
      const location = item.line ? `${item.path}:${item.line}` : item.path;
      lines.push(`  at ${location}${item.detail ? ` — ${item.detail}` : ''}`);
    }
    if (finding.fix) {
      lines.push(`  fix (${finding.fix.type}): ${finding.fix.summary}`);
      for (const step of finding.fix.steps) {
        const prefix = finding.fix.type === 'mutation' ? 'would' : 'then';
        lines.push(`    ${prefix} ${step}`);
      }
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * Render run-level warnings that are not tied to one check.
 *
 * @param {string[]} warnings Warning lines.
 * @returns {string} Warning block, empty when there is nothing to say.
 */
export function renderWarnings(warnings) {
  if (!warnings || warnings.length === 0) return '';
  return warnings.map((warning) => `warning: ${warning}`).join('\n');
}

/**
 * Render the summary line for one run.
 *
 * @param {object} summary Counts by status.
 * @returns {string} Summary text.
 */
export function renderSummary(summary) {
  return `${summary.pass} pass · ${summary.info} info · ${summary.warn} warn · ${summary.fail} fail · ${summary.skip} skip (${summary.total} checks)`;
}

/**
 * Map a report to a process exit code.
 *
 * @param {object} summary Counts by status.
 * @param {boolean} strict Treat warnings as failures.
 * @returns {number} `1` when the run should fail CI, otherwise `0`.
 */
export function exitCodeFor(summary, strict) {
  if (summary.fail > 0) return 1;
  if (strict && summary.warn + summary.info > 0) return 1;
  return 0;
}
