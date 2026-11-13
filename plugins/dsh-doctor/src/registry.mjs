import manifest from './checks.data.json' with { type: 'json' };
import { parseRange, satisfiesRange } from './semver.mjs';

/** Groups a check can belong to, in report order. */
export const GROUPS = ['install', 'plugin', 'config', 'state', 'workspace'];

/** Severities a check can declare. */
export const SEVERITIES = ['info', 'warn', 'error'];

const ID_PATTERN = /^[a-z]+(\.[a-z0-9]+(-[a-z0-9]+)*){1,2}$/;

/**
 * A failure this tool reports to the operator rather than crashing on.
 */
export class DoctorError extends Error {
  /**
   * @param {string} code Stable machine-readable code.
   * @param {string} message Operator-facing description.
   */
  constructor(code, message) {
    super(message);
    this.name = 'DoctorError';
    this.code = code;
  }
}

/**
 * Reject a check manifest that would make findings unreliable.
 *
 * A check that cannot name its group, severity, or applicability is worse than
 * no check, so every rule here fails the whole manifest instead of one entry.
 *
 * @param {{checks: object[]}} document Parsed `checks.data.json`.
 * @param {Record<string, Function>} implementations id to implementation map.
 * @returns {object[]} The validated check entries.
 * @throws {DoctorError} When any entry, id, or range is invalid.
 */
export function validateManifest(document, implementations) {
  if (!document || !Array.isArray(document.checks) || document.checks.length === 0) {
    throw new DoctorError('manifest-empty', 'the check manifest declares no checks');
  }
  const seen = new Set();
  for (const check of document.checks) {
    if (typeof check.id !== 'string' || !ID_PATTERN.test(check.id)) {
      throw new DoctorError('manifest-bad-id', `check id ${JSON.stringify(check.id)} is not a dotted lowercase id`);
    }
    if (seen.has(check.id)) {
      throw new DoctorError('manifest-duplicate-id', `check id "${check.id}" is declared more than once`);
    }
    seen.add(check.id);
    if (!GROUPS.includes(check.group)) {
      throw new DoctorError('manifest-bad-group', `check "${check.id}" declares group ${JSON.stringify(check.group)}`);
    }
    if (!SEVERITIES.includes(check.severity)) {
      throw new DoctorError('manifest-bad-severity', `check "${check.id}" declares severity ${JSON.stringify(check.severity)}`);
    }
    if (typeof check.title !== 'string' || check.title.trim() === '') {
      throw new DoctorError('manifest-bad-title', `check "${check.id}" has no title`);
    }
    if (typeof check.why !== 'string' || check.why.trim() === '') {
      throw new DoctorError('manifest-bad-why', `check "${check.id}" does not say why it exists`);
    }
    if (typeof check.harness !== 'string' || parseRange(check.harness) === null) {
      throw new DoctorError('manifest-bad-range', `check "${check.id}" has an unparsable harness range ${JSON.stringify(check.harness)}`);
    }
    if (typeof implementations[check.id] !== 'function') {
      throw new DoctorError('manifest-no-impl', `check "${check.id}" has no implementation`);
    }
  }
  return document.checks;
}

/**
 * Load and validate the shipped check manifest.
 *
 * @param {Record<string, Function>} implementations id to implementation map.
 * @returns {{checks: object[], knownSettingsKeys: string[]}} Validated manifest.
 */
export function loadManifest(implementations) {
  const checks = validateManifest(manifest, implementations);
  return {
    checks,
    knownSettingsKeys: Array.isArray(manifest.knownSettingsKeys) ? manifest.knownSettingsKeys : [],
  };
}

/**
 * Decide which checks apply to this workspace and this harness version.
 *
 * Version gating lives here: a check declaring a harness range is dropped when
 * the installed version is unknown or outside the range, so an upgrade cannot
 * leave a stale check active.
 *
 * @param {object} options Selection options.
 * @param {object[]} options.checks Validated manifest entries.
 * @param {string | null} options.harnessVersion Installed harness version.
 * @param {string[]} [options.groups] Restrict to these groups.
 * @param {string[]} [options.only] Restrict to these check ids.
 * @param {string[]} [options.mute] Suppress these check ids.
 * @returns {{selected: object[], skipped: {id: string, reason: string, code: string}[], filtered: {id: string, reason: string}[]}}
 *   `filtered` holds checks excluded by an explicit scope request, which the
 *   report omits entirely; `skipped` holds checks that still apply but were
 *   suppressed by mute or by their harness range, which the report lists.
 *   `code` distinguishes `mute`, `version-unknown`, and `version-range`.
 */
export function selectChecks({ checks, harnessVersion, groups = [], only = [], mute = [] }) {
  const selected = [];
  const skipped = [];
  const filtered = [];
  for (const check of checks) {
    if (groups.length > 0 && !groups.includes(check.group)) {
      filtered.push({ id: check.id, reason: `group "${check.group}" was not requested` });
      continue;
    }
    if (only.length > 0 && !only.includes(check.id)) {
      filtered.push({ id: check.id, reason: 'not named by --check' });
      continue;
    }
    if (mute.includes(check.id)) {
      skipped.push({ id: check.id, reason: 'muted by --mute', code: 'mute' });
      continue;
    }
    if (check.harness !== '*') {
      if (!harnessVersion) {
        skipped.push({
          id: check.id,
          reason: `applies to harness ${check.harness} but the installed version is unknown`,
          code: 'version-unknown',
        });
        continue;
      }
      if (!satisfiesRange(harnessVersion, check.harness)) {
        skipped.push({
          id: check.id,
          reason: `applies to harness ${check.harness}, installed ${harnessVersion}`,
          code: 'version-range',
        });
        continue;
      }
    }
    selected.push(check);
  }
  return { selected, skipped, filtered };
}
