const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];

/**
 * Whether a manifest field is a plain dependency map.
 *
 * @param {unknown} value Candidate value.
 * @returns {value is Record<string, string>} `true` for a non-array object.
 */
function isDependencyMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Collect the dependency names a package manifest declares.
 *
 * @param {object} context Workspace context.
 * @returns {{names: string[], manifest: object} | null} Declared names, or `null` without a manifest.
 */
function declaredDependencies(context) {
  const parsed = context.readJson('package.json');
  if (!parsed.ok) return null;
  const manifest = parsed.value;
  if (!isDependencyMap(manifest)) return null;
  const merged = {
    ...(isDependencyMap(manifest.dependencies) ? manifest.dependencies : {}),
    ...(isDependencyMap(manifest.devDependencies) ? manifest.devDependencies : {}),
  };
  return { names: Object.keys(merged).sort(), manifest };
}

/**
 * Collect every package name the lockfile records as a resolved entry or key.
 *
 * Names are matched at entry boundaries, so an unscoped `foo` is not satisfied
 * by a scoped `@scope/foo` entry. This is still a text heuristic: it proves
 * presence, not the resolved version.
 *
 * @param {string} text Lockfile contents.
 * @returns {Set<string>} Recorded package names.
 */
function recordedNames(text) {
  const names = new Set();
  const entry = /^\s*'?((?:@[^/\s']+\/)?[^@\s']+)@([^\s'/:]+)'?\s*:?\s*$/gm;
  const key = /^\s*'?((?:@[^/\s']+\/)?[^@\s':]+)'?\s*:/gm;
  for (const match of text.matchAll(entry)) names.add(match[1]);
  for (const match of text.matchAll(key)) names.add(match[1]);
  return names;
}

/**
 * Fail when dependencies are declared but no lockfile exists.
 *
 * @param {object} context Workspace context.
 * @returns {object} Check outcome.
 */
export function lockfileMissing(context) {
  const declared = declaredDependencies(context);
  if (!declared) return { skip: 'no package.json at the workspace root' };
  if (declared.names.length === 0) {
    return {
      ok: true,
      summary: 'package.json declares no dependencies',
      evidence: [{ path: 'package.json', detail: 'no dependencies or devDependencies' }],
    };
  }
  const present = LOCKFILES.filter((file) => context.exists(file));
  if (present.length > 0) {
    return { ok: true, summary: `lockfile present: ${present[0]}`, evidence: [{ path: present[0] }] };
  }
  return {
    ok: false,
    summary: `package.json declares ${declared.names.length} dependencies but no lockfile exists`,
    evidence: [{ path: 'package.json', detail: `expected one of ${LOCKFILES.join(', ')}` }],
  };
}

/**
 * Fail when declared dependencies have no installed tree.
 *
 * @param {object} context Workspace context.
 * @returns {object} Check outcome.
 */
export function nodeModulesMissing(context) {
  const declared = declaredDependencies(context);
  if (!declared) return { skip: 'no package.json at the workspace root' };
  if (declared.names.length === 0) return { skip: 'no declared dependencies' };
  if (context.exists('node_modules')) {
    return { ok: true, summary: 'node_modules is present', evidence: [{ path: 'node_modules' }] };
  }
  return {
    ok: false,
    summary: `${declared.names.length} declared dependencies are not installed`,
    evidence: [{ path: 'node_modules', detail: 'directory does not exist' }],
  };
}

/**
 * Fail when a declared dependency is absent from the lockfile.
 *
 * @param {object} context Workspace context.
 * @returns {object} Check outcome.
 */
export function lockfileDrift(context) {
  const declared = declaredDependencies(context);
  if (!declared) return { skip: 'no package.json at the workspace root' };
  if (declared.names.length === 0) return { skip: 'no declared dependencies' };
  const lockfile = LOCKFILES.find((file) => context.exists(file));
  if (!lockfile) return { skip: 'no lockfile to compare against' };
  const text = context.readText(lockfile) ?? '';
  const recorded = recordedNames(text);
  const missing = declared.names.filter((name) => !recorded.has(name));
  if (missing.length === 0) {
    return {
      ok: true,
      summary: `${declared.names.length} declared dependencies appear in ${lockfile}`,
      evidence: [{ path: lockfile, detail: 'every declared dependency name is recorded' }],
    };
  }
  return {
    ok: false,
    summary: `${missing.length} declared dependencies are absent from ${lockfile}`,
    evidence: missing.slice(0, 10).map((name) => ({
      path: 'package.json',
      detail: `${name} is declared but not recorded in ${lockfile}`,
    })),
  };
}

/**
 * Split one pnpm virtual-store directory name into a package name and version.
 *
 * pnpm names scoped entries `@scope+name@version`, so the scope separator is a
 * `+` rather than a `/`.
 *
 * @param {string} entry Directory name.
 * @returns {{name: string, version: string} | null} Parsed entry, or `null` when it is not a package link.
 */
function parseStoreEntry(entry) {
  if (!entry.startsWith('@')) {
    const separator = entry.indexOf('@');
    if (separator <= 0) return null;
    return { name: entry.slice(0, separator), version: entry.slice(separator + 1) };
  }
  const separator = entry.lastIndexOf('@');
  if (separator <= 1) return null;
  return {
    name: entry.slice(0, separator).replace('+', '/'),
    version: entry.slice(separator + 1),
  };
}

/**
 * Warn when one dependency resolves to more than one version.
 *
 * @param {object} context Workspace context.
 * @returns {object} Check outcome.
 */
export function duplicateVersions(context) {
  const store = 'node_modules/.pnpm';
  if (!context.exists(store)) return { skip: 'no pnpm virtual store to inspect' };
  const versions = new Map();
  for (const entry of context.list(store)) {
    if (!entry.dir) continue;
    const parsed = parseStoreEntry(entry.name);
    if (!parsed || parsed.version === '') continue;
    const bucket = versions.get(parsed.name) ?? new Set();
    bucket.add(parsed.version);
    versions.set(parsed.name, bucket);
  }
  const duplicated = [...versions].filter(([, set]) => set.size > 1);
  if (duplicated.length === 0) {
    return {
      ok: true,
      summary: `no dependency is installed at more than one version (${versions.size} packages)`,
      evidence: [{ path: store }],
    };
  }
  return {
    ok: false,
    summary: `${duplicated.length} dependencies are installed at multiple versions`,
    evidence: duplicated.slice(0, 10).map(([name, set]) => ({
      path: store,
      detail: `${name}: ${[...set].sort().join(', ')}`,
    })),
  };
}
