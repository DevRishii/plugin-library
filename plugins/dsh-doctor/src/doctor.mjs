import { createContext } from './context.mjs';
import { IMPLEMENTATIONS } from './checks/index.mjs';
import { DoctorError, loadManifest, selectChecks } from './registry.mjs';
import { planFix } from './fixes.mjs';
import { appendHistory, ensureHistoryDirectory, readHistory } from './history.mjs';
import { diffFindings } from './changes.mjs';
import { exitCodeFor } from './render.mjs';

/**
 * Map a declared severity to the status a failed finding reports.
 *
 * @param {string} severity Declared severity.
 * @returns {string} Finding status.
 */
function failingStatus(severity) {
  if (severity === 'error') return 'fail';
  if (severity === 'warn') return 'warn';
  return 'info';
}

/**
 * Read the installed harness version from the workspace.
 *
 * @param {object} context Workspace context.
 * @returns {string | null} Version, or `null` when the workspace has no harness manifest.
 */
export function detectHarnessVersion(context) {
  const nested = context.readJson('dsh-src/package.json');
  if (nested.ok && typeof nested.value?.version === 'string') return nested.value.version;
  const rootManifest = context.readJson('package.json');
  if (rootManifest.ok && typeof rootManifest.value?.version === 'string') {
    if (String(rootManifest.value.name ?? '').startsWith('@deepseek-ai/dsh')) return rootManifest.value.version;
  }
  return null;
}

/**
 * Run one check and normalize its outcome into a finding.
 *
 * @param {object} check Manifest entry.
 * @param {object} context Workspace context.
 * @param {Record<string, Function>} implementations id to implementation map.
 * @returns {object} Finding.
 */
function executeCheck(check, context, implementations) {
  const base = {
    id: check.id,
    group: check.group,
    severity: check.severity,
    title: check.title,
    evidence: [],
    fix: null,
  };
  let outcome;
  try {
    outcome = implementations[check.id](context);
  } catch (error) {
    return {
      ...base,
      status: 'fail',
      summary: `the check threw while inspecting the workspace: ${error instanceof Error ? error.message : String(error)}`,
      evidence: [{ path: '.', detail: 'the check did not complete' }],
    };
  }
  if (!outcome || typeof outcome !== 'object') {
    return { ...base, status: 'fail', summary: 'the check returned no outcome', evidence: [{ path: '.' }] };
  }
  if (typeof outcome.skip === 'string') {
    return { ...base, status: 'skip', summary: outcome.skip };
  }
  const ok = outcome.ok === true;
  const finding = {
    ...base,
    status: ok ? 'pass' : failingStatus(check.severity),
    summary: typeof outcome.summary === 'string' ? outcome.summary : '',
    evidence: Array.isArray(outcome.evidence) ? outcome.evidence : [],
  };
  if (!ok) finding.fix = planFix(context, check.id, finding);
  return finding;
}

/**
 * Run the doctor suite against one workspace.
 *
 * Selection, execution, fix planning, and history recording all happen here so
 * the CLI stays a thin transport.
 *
 * @param {object} [options] Run options.
 * @param {string} [options.root] Workspace root, defaults to the current directory.
 * @param {string | null} [options.harnessVersion] Override the detected harness version.
 * @param {string[]} [options.groups] Restrict to these groups.
 * @param {string[]} [options.only] Restrict to these check ids.
 * @param {string[]} [options.mute] Suppress these check ids.
 * @param {Date} [options.now] Clock used for age comparisons and the record timestamp.
 * @param {boolean} [options.history] Whether to append a history record.
 * @param {boolean} [options.compare] Whether to diff against the previous record.
 * @param {number} [options.stateTtlMs] Orphaned-lock TTL.
 * @param {number} [options.largeFileBytes] Root file size budget.
 * @param {number} [options.sessionStoreBytes] Session store size budget.
 * @param {Record<string, Function>} [options.implementations] Override the implementation map.
 * @returns {object} Report with findings, counts, and the exit code the CLI should use.
 */
export function runDoctor(options = {}) {
  const implementations = options.implementations ?? IMPLEMENTATIONS;
  const manifest = options.manifest ?? loadManifest(implementations);
  const root = options.root ?? process.cwd();
  const context = createContext({
    root,
    harnessVersion: options.harnessVersion ?? null,
    now: options.now ?? new Date(),
    stateTtlMs: options.stateTtlMs,
    largeFileBytes: options.largeFileBytes,
    sessionStoreBytes: options.sessionStoreBytes,
    knownSettingsKeys: manifest.knownSettingsKeys,
  });
  if (!context.exists('.')) {
    throw new DoctorError('root-missing', `workspace root does not exist: ${root}`);
  }
  if (!context.harnessVersion) context.harnessVersion = detectHarnessVersion(context);

  // A recorded run creates .dsh, which some checks inspect, so create it first.
  if (options.history !== false) ensureHistoryDirectory(context);

  // Read the previous record before this run appends its own.
  const previousRecord = options.compare ? (readHistory(context).at(-1) ?? null) : null;

  const { skipped, filtered } = selectChecks({
    checks: manifest.checks,
    harnessVersion: context.harnessVersion,
    groups: options.groups ?? [],
    only: options.only ?? [],
    mute: options.mute ?? [],
  });
  const skipReasons = new Map(skipped.map((entry) => [entry.id, entry.reason]));
  const omitted = new Set(filtered.map((entry) => entry.id));

  const findings = manifest.checks
    .filter((check) => !omitted.has(check.id))
    .map((check) => {
    const reason = skipReasons.get(check.id);
    if (reason) {
      return {
        id: check.id,
        group: check.group,
        severity: check.severity,
        title: check.title,
        status: 'skip',
        summary: reason,
        evidence: [],
        fix: null,
      };
    }
    return executeCheck(check, context, implementations);
  });

  const summary = { pass: 0, info: 0, warn: 0, fail: 0, skip: 0, total: findings.length };
  for (const finding of findings) summary[finding.status] += 1;

  const warnings = [];
  const unknownVersionSkips = skipped.filter((entry) => entry.code === 'version-unknown');
  if (unknownVersionSkips.length > 0) {
    warnings.push(
      `the installed harness version could not be detected, so ${unknownVersionSkips.length} of ${findings.length} checks were skipped; pass --harness-version to evaluate them`,
    );
  }

  const changes = options.compare
    ? previousRecord
      ? { since: previousRecord.generatedAt, ...diffFindings(previousRecord.findings ?? [], findings) }
      : { since: null, added: [], changed: [], removed: [] }
    : null;

  const report = {
    tool: 'dsh-doctor',
    generatedAt: context.now.toISOString(),
    root: context.root,
    harnessVersion: context.harnessVersion,
    findings,
    summary,
    warnings,
    changes,
    exitCode: exitCodeFor(summary, options.strict === true),
  };

  if (options.history !== false) {
    report.historyFile = appendHistory(context, {
      generatedAt: report.generatedAt,
      harnessVersion: report.harnessVersion,
      summary,
      findings: findings.map((finding) => ({
        id: finding.id,
        status: finding.status,
        severity: finding.severity,
        summary: finding.summary,
        evidence: finding.evidence,
      })),
    });
  }

  return report;
}
