/**
 * Reduce a doctor report to the defect findings a backlog board consumes.
 *
 * The normal report keeps every check, including the ones that passed or were
 * skipped, because the table is an operator view of the whole run. A backlog
 * feed only wants the findings that name something to repair, together with
 * the finder metadata that already describes them.
 *
 * `passing` lists the checks that ran and passed, so the consumer can close a
 * backlog entry whose defect no longer reproduces without receiving the full
 * report.
 *
 * @param {object} report Report returned by `runDoctor`.
 * @returns {{source: string, generatedAt: string, harnessVersion: string | null, findings: object[], passing: string[]}} Backlog payload.
 */
export function reportToNightmares(report) {
  const all = report.findings ?? [];
  const findings = all
    .filter((finding) => finding.status !== 'pass' && finding.status !== 'skip')
    .map((finding) => ({
      id: finding.id,
      group: finding.group,
      severity: finding.severity,
      title: finding.title,
      status: finding.status,
      summary: finding.summary,
      evidence: finding.evidence,
      fix: finding.fix,
    }));
  const passing = all
    .filter((finding) => finding.status === 'pass')
    .map((finding) => finding.id);
  return {
    source: 'dsh-doctor',
    generatedAt: report.generatedAt,
    harnessVersion: report.harnessVersion ?? null,
    findings,
    passing,
  };
}
