import { satisfiesRange } from '../semver.mjs';

const SCAN_ROOTS = ['', 'node_modules/@local', 'node_modules/@deepseek-ai'];

/**
 * Decide whether a package directory behaves as a harness plugin.
 *
 * A package qualifies when it exposes a loadable entry (`main` or a `.` export)
 * or depends on cordis. Repository roots and preset bundles have neither, and
 * reporting them would drown the real findings.
 *
 * @param {object} manifest Parsed package manifest.
 * @returns {boolean} `true` when the package is a plugin.
 */
function isPlugin(manifest) {
  if (!manifest || typeof manifest.name !== 'string') return false;
  if (typeof manifest.main === 'string') return true;
  if (hasRootExport(manifest)) return true;
  return Boolean(
    manifest.peerDependencies?.['@deepseek-ai/cordis'] ??
      manifest.dependencies?.['@deepseek-ai/cordis'] ??
      manifest.devDependencies?.['@deepseek-ai/cordis'],
  );
}

/**
 * Whether a manifest declares a `.` export.
 *
 * @param {object} manifest Parsed package manifest.
 * @returns {boolean} `true` when a root export is declared.
 */
function hasRootExport(manifest) {
  const exports = manifest.exports;
  if (!exports) return false;
  if (typeof exports === 'string') return true;
  if (typeof exports !== 'object') return false;
  const root = exports['.'];
  if (root === undefined) return false;
  return root !== null && (typeof root === 'string' || typeof root === 'object');
}

/**
 * Resolve the file a manifest points at as its entry.
 *
 * @param {object} manifest Parsed package manifest.
 * @returns {string | null} Entry target, or `null` when the manifest names none.
 */
function entryTarget(manifest) {
  if (typeof manifest.main === 'string') return manifest.main;
  const exports = manifest.exports;
  if (typeof exports === 'string') return exports;
  if (!exports || typeof exports !== 'object') return null;
  const root = exports['.'];
  if (typeof root === 'string') return root;
  if (!root || typeof root !== 'object') return null;
  const target = root.default ?? root.import ?? root.node ?? null;
  return typeof target === 'string' ? target : null;
}

/**
 * Find every plugin package reachable from the workspace root.
 *
 * @param {object} context Workspace context.
 * @returns {{dir: string, manifest: object, name: string}[]} Plugins sorted by directory.
 */
export function discoverPlugins(context) {
  const found = [];
  const seen = new Set();
  for (const base of SCAN_ROOTS) {
    for (const entry of context.list(base)) {
      if (!entry.dir || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const directory = base === '' ? entry.name : `${base}/${entry.name}`;
      if (seen.has(directory)) continue;
      const parsed = context.readJson(`${directory}/package.json`);
      if (!parsed.ok || !isPlugin(parsed.value)) continue;
      seen.add(directory);
      found.push({ dir: directory, manifest: parsed.value, name: parsed.value.name });
    }
  }
  return found.sort((left, right) => left.dir.localeCompare(right.dir));
}

/**
 * Fail when two packages declare the same plugin id.
 *
 * @param {object} context Workspace context.
 * @returns {object} Check outcome.
 */
export function duplicatePluginId(context) {
  const plugins = discoverPlugins(context);
  if (plugins.length === 0) return { skip: 'no plugin packages were found' };
  const byName = new Map();
  for (const plugin of plugins) {
    const bucket = byName.get(plugin.name) ?? [];
    bucket.push(plugin);
    byName.set(plugin.name, bucket);
  }
  const duplicates = [...byName].filter(([, list]) => list.length > 1);
  if (duplicates.length === 0) {
    return {
      ok: true,
      summary: `${plugins.length} plugin packages declare unique ids`,
      evidence: [{ path: '.', detail: plugins.map((plugin) => plugin.dir).join(', ') }],
    };
  }
  return {
    ok: false,
    summary: `${duplicates.length} plugin ids are provided by more than one package`,
    evidence: duplicates.flatMap(([name, list]) =>
      list.map((plugin) => ({
        path: `${plugin.dir}/package.json`,
        detail: `${name} is also declared by ${list.filter((other) => other !== plugin).map((other) => other.dir).join(', ')}`,
      })),
    ),
  };
}

/**
 * Fail when a plugin excludes the installed harness in engines.dsh.
 *
 * @param {object} context Workspace context.
 * @returns {object} Check outcome.
 */
export function engineMismatch(context) {
  if (!context.harnessVersion) return { skip: 'the installed harness version is unknown' };
  const declared = discoverPlugins(context).filter((plugin) => typeof plugin.manifest.engines?.dsh === 'string');
  if (declared.length === 0) return { skip: 'no plugin declares an engines.dsh range' };
  const broken = declared.filter(
    (plugin) => !satisfiesRange(context.harnessVersion, plugin.manifest.engines.dsh),
  );
  if (broken.length === 0) {
    return {
      ok: true,
      summary: `${declared.length} plugins accept harness ${context.harnessVersion}`,
      evidence: [{ path: '.', detail: declared.map((plugin) => plugin.dir).join(', ') }],
    };
  }
  return {
    ok: false,
    summary: `${broken.length} plugins exclude harness ${context.harnessVersion}`,
    evidence: broken.map((plugin) => ({
      path: `${plugin.dir}/package.json`,
      detail: `engines.dsh is ${plugin.manifest.engines.dsh}`,
    })),
  };
}

/**
 * Warn when a plugin ships a client bundle older than its manifest or sources.
 *
 * @param {object} context Workspace context.
 * @returns {object} Check outcome.
 */
export function clientBundleStale(context) {
  const plugins = discoverPlugins(context).filter((plugin) => context.exists(`${plugin.dir}/client.js`));
  if (plugins.length === 0) return { skip: 'no plugin ships a client bundle' };
  const stale = plugins.filter((plugin) => {
    const bundle = context.stat(`${plugin.dir}/client.js`);
    if (!bundle) return false;
    let newestSource = 0;
    for (const name of ['package.json', 'index.js']) {
      const source = context.stat(`${plugin.dir}/${name}`);
      if (source && source.mtimeMs > newestSource) newestSource = source.mtimeMs;
    }
    if (context.exists(`${plugin.dir}/src`)) {
      context.walk(`${plugin.dir}/src`, 6, (path, metadata) => {
        if (metadata.mtimeMs > newestSource) newestSource = metadata.mtimeMs;
      });
    }
    return newestSource > bundle.mtimeMs;
  });
  if (stale.length === 0) {
    return {
      ok: true,
      summary: `${plugins.length} client bundles are newer than their sources`,
      evidence: [{ path: '.', detail: plugins.map((plugin) => plugin.dir).join(', ') }],
    };
  }
  return {
    ok: false,
    summary: `${stale.length} client bundles are older than their sources`,
    evidence: stale.map((plugin) => ({
      path: `${plugin.dir}/client.js`,
      detail: 'bundle mtime precedes package.json, index.js, or src',
    })),
  };
}

/**
 * Warn when a plugin manifest points at an entry file that is absent.
 *
 * @param {object} context Workspace context.
 * @returns {object} Check outcome.
 */
export function entryMissing(context) {
  const plugins = discoverPlugins(context);
  if (plugins.length === 0) return { skip: 'no plugin packages were found' };
  const broken = plugins.filter((plugin) => {
    const target = entryTarget(plugin.manifest);
    if (target === null) return true;
    return !context.exists(`${plugin.dir}/${target.replace(/^\.\//, '')}`);
  });
  if (broken.length === 0) {
    return {
      ok: true,
      summary: `${plugins.length} plugin manifests point at a resolvable entry`,
      evidence: [{ path: '.', detail: plugins.map((plugin) => plugin.dir).join(', ') }],
    };
  }
  return {
    ok: false,
    summary: `${broken.length} plugin manifests have an unresolvable entry`,
    evidence: broken.map((plugin) => {
      const target = entryTarget(plugin.manifest);
      return {
        path: `${plugin.dir}/package.json`,
        detail: target === null ? 'manifest names no entry' : `entry "${target}" does not exist`,
      };
    }),
  };
}
