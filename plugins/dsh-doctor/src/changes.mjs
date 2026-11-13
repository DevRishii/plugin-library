/**
 * Compare the findings of two runs.
 *
 * Findings are keyed by check id, so a status change is reported once rather
 * than as a removal plus an addition.
 *
 * @param {object[]} previous Findings from the earlier run.
 * @param {object[]} current Findings from the later run.
 * @returns {{added: object[], changed: object[], removed: object[]}} Differences.
 */
export function diffFindings(previous, current) {
  const before = new Map(previous.map((finding) => [finding.id, finding]));
  const currentIds = new Set(current.map((finding) => finding.id));
  const added = [];
  const changed = [];
  const removed = [];
  for (const finding of current) {
    const earlier = before.get(finding.id);
    if (!earlier) {
      added.push({
        id: finding.id,
        status: finding.status,
        severity: finding.severity,
        summary: finding.summary,
      });
      continue;
    }
    if (earlier.status !== finding.status) {
      changed.push({
        id: finding.id,
        from: earlier.status,
        to: finding.status,
        severity: finding.severity,
        summary: finding.summary,
      });
    }
  }
  for (const earlier of previous) {
    if (!currentIds.has(earlier.id)) removed.push({ id: earlier.id, status: earlier.status });
  }
  return { added, changed, removed };
}

/**
 * Count the differences in a comparison.
 *
 * @param {{added: object[], changed: object[], removed: object[]}} changes Differences.
 * @returns {number} Total differences.
 */
export function countChanges(changes) {
  return changes.added.length + changes.changed.length + changes.removed.length;
}

/**
 * Render a comparison as operator-facing text.
 *
 * @param {{added: object[], changed: object[], removed: object[]}} changes Differences.
 * @param {string | null} since Timestamp of the earlier run.
 * @returns {string} Comparison text.
 */
export function renderChanges(changes, since) {
  if (!since) return 'changes: no previous run is recorded, so this is the first entry';
  if (countChanges(changes) === 0) return `changes: none since ${since}`;
  const lines = [`changes since ${since}:`];
  for (const change of changes.changed) {
    lines.push(`  changed  ${change.id}  ${change.from} -> ${change.to}`);
  }
  for (const entry of changes.added) {
    lines.push(`  new      ${entry.id}  ${entry.status}`);
  }
  for (const entry of changes.removed) {
    lines.push(`  gone     ${entry.id}  (was ${entry.status})`);
  }
  return lines.join('\n');
}
