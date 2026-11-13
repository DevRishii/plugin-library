import { occurrencesOf, readHistory } from './history.mjs';
import { DoctorError } from './registry.mjs';
import { satisfiesRange } from './semver.mjs';

/**
 * Assemble everything the operator needs about one check.
 *
 * The history log is the only record of what broke before, so the explanation
 * always carries the `path:line` of the recorded failure rather than a summary
 * of it.
 *
 * @param {object} options Explanation options.
 * @param {string} options.id Check id.
 * @param {object[]} [options.checks] Validated manifest entries.
 * @param {object} options.context Workspace context used to read history.
 * @param {string | null} [options.harnessVersion] Installed version used to report gating.
 * @returns {{check: object, latest: object | null, occurrences: object[], inapplicable: string | null}}
 *   Explanation; `inapplicable` names why the check would not run today.
 * @throws {DoctorError} When the id is not in the manifest.
 */
export function explainCheck({ id, checks, context, harnessVersion = null }) {
  const manifest = checks;
  if (!Array.isArray(manifest)) {
    throw new DoctorError('no-manifest', 'explaining a check requires the validated check manifest');
  }
  const check = manifest.find((entry) => entry.id === id);
  if (!check) throw new DoctorError('unknown-check', `unknown check id "${id}"`);
  const records = readHistory(context);
  const occurrences = occurrencesOf(records, id).reverse();
  let inapplicable = null;
  if (check.harness !== '*') {
    if (!harnessVersion) {
      inapplicable = `this check declares harness ${check.harness} and the installed version is unknown, so it is skipped today`;
    } else if (!satisfiesRange(harnessVersion, check.harness)) {
      inapplicable = `this check declares harness ${check.harness} and the installed version is ${harnessVersion}, so it is skipped today`;
    }
  }
  return { check, latest: occurrences[0] ?? null, occurrences: occurrences.slice(0, 5), inapplicable };
}

/**
 * Render an explanation as operator-facing text.
 *
 * @param {{check: object, latest: object | null, occurrences: object[]}} result Explanation.
 * @param {string | null} harnessVersion Installed harness version.
 * @returns {string} Explanation text.
 */
export function renderExplanation(result, harnessVersion) {
  const { check, latest, occurrences, inapplicable } = result;
  const lines = [
    `${check.id} — ${check.title}`,
    `group ${check.group} · severity ${check.severity} · applies to harness ${check.harness}`,
    '',
    `Why this check exists: ${check.why}`,
  ];
  if (inapplicable) lines.push('', `Status: ${inapplicable}`);
  if (!latest) {
    lines.push('', `No failure is recorded in .dsh/doctor/history.jsonl${harnessVersion ? ` (harness ${harnessVersion})` : ''}.`);
    return lines.join('\n');
  }
  lines.push('', `Last failure ${latest.at}${latest.harnessVersion ? ` on harness ${latest.harnessVersion}` : ''}`);
  lines.push(`  ${latest.status.toUpperCase()} ${latest.summary}`);
  for (const item of latest.evidence) {
    const location = item.line ? `${item.path}:${item.line}` : item.path;
    lines.push(`  at ${location}${item.detail ? ` — ${item.detail}` : ''}`);
  }
  lines.push(`  log: ${latest.logPath}:${latest.line}`);
  if (occurrences.length > 1) {
    lines.push('', `Earlier recorded failures: ${occurrences.length - 1}`);
    for (const occurrence of occurrences.slice(1)) {
      lines.push(`  ${occurrence.at} ${occurrence.status} — ${occurrence.logPath}:${occurrence.line}`);
    }
  }
  return lines.join('\n');
}
