const SETTINGS = '.dsh/settings.json';

/**
 * Whether a settings value looks like an absolute path.
 *
 * @param {string} value Candidate value.
 * @returns {boolean} `true` for POSIX and Windows absolute paths.
 */
function looksAbsolute(value) {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Fail when the settings file is not valid JSON.
 *
 * @param {object} context Workspace context.
 * @returns {object} Check outcome.
 */
export function settingsParse(context) {
  if (!context.exists(SETTINGS)) return { skip: 'no .dsh/settings.json to validate' };
  const parsed = context.readJson(SETTINGS);
  if (parsed.ok) {
    return {
      ok: true,
      summary: '.dsh/settings.json parses as JSON',
      evidence: [{ path: SETTINGS }],
    };
  }
  return {
    ok: false,
    summary: `.dsh/settings.json is not valid JSON: ${parsed.error}`,
    evidence: [{ path: SETTINGS, detail: parsed.error }],
  };
}

/**
 * Warn when the settings file carries keys the harness does not read.
 *
 * @param {object} context Workspace context.
 * @returns {object} Check outcome.
 */
export function settingsUnknownKey(context) {
  const parsed = context.readJson(SETTINGS);
  if (!parsed.ok) return { skip: 'settings file is missing or unparsable' };
  const known = new Set(context.knownSettingsKeys);
  if (known.size === 0) return { skip: 'no known settings keys were configured' };
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return {
      ok: false,
      summary: '.dsh/settings.json does not contain a JSON object',
      evidence: [{ path: SETTINGS, detail: 'top-level value is not an object' }],
    };
  }
  const unknown = Object.keys(parsed.value).filter((key) => !known.has(key));
  if (unknown.length === 0) {
    return {
      ok: true,
      summary: `${Object.keys(parsed.value).length} settings keys are recognized`,
      evidence: [{ path: SETTINGS }],
    };
  }
  return {
    ok: false,
    summary: `${unknown.length} settings keys are not recognized`,
    evidence: unknown.map((key) => ({
      path: SETTINGS,
      detail: `"${key}" is not a harness setting and is ignored`,
    })),
  };
}

/**
 * Warn when an absolute-path setting points at a path that is gone.
 *
 * @param {object} context Workspace context.
 * @returns {object} Check outcome.
 */
export function settingsStalePath(context) {
  const parsed = context.readJson(SETTINGS);
  if (!parsed.ok) return { skip: 'settings file is missing or unparsable' };
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return { skip: 'settings file is not an object' };
  }
  const stale = Object.entries(parsed.value)
    .filter(([, value]) => typeof value === 'string' && looksAbsolute(value) && !context.exists(value));
  if (stale.length === 0) {
    return {
      ok: true,
      summary: 'every absolute path in settings resolves',
      evidence: [{ path: SETTINGS }],
    };
  }
  return {
    ok: false,
    summary: `${stale.length} absolute paths in settings do not exist`,
    evidence: stale.map(([key, value]) => ({
      path: SETTINGS,
      detail: `"${key}" points at ${value}, which does not exist`,
    })),
  };
}
