import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

/**
 * Build the read-only view of a workspace that every check receives.
 *
 * All helpers resolve paths against `root`; nothing here mutates the workspace.
 *
 * @param {object} options Context options.
 * @param {string} options.root Workspace root directory.
 * @param {string | null} [options.harnessVersion] Installed harness version.
 * @param {Date} [options.now] Clock used for age comparisons.
 * @param {number} [options.stateTtlMs] Age after which a lock file counts as orphaned.
 * @param {number} [options.largeFileBytes] Size above which a root file is reported.
 * @param {number} [options.sessionStoreBytes] Size above which the session store is reported.
 * @param {string[]} [options.knownSettingsKeys] Settings keys the harness recognizes.
 * @returns {object} Workspace context passed to every check implementation.
 */
export function createContext(options) {
  const root = resolve(options.root);

  /**
   * @param {string} target Workspace-relative or absolute path.
   * @returns {string} Absolute path.
   */
  const absolute = (target) => resolve(root, target);

  const context = {
    root,
    harnessVersion: options.harnessVersion ?? null,
    now: options.now ?? new Date(),
    stateTtlMs: options.stateTtlMs ?? 30 * 60 * 1000,
    largeFileBytes: options.largeFileBytes ?? 5 * 1024 * 1024,
    sessionStoreBytes: options.sessionStoreBytes ?? 50 * 1024 * 1024,
    knownSettingsKeys: options.knownSettingsKeys ?? [],

    absolute,

    /**
     * Report whether a path exists.
     *
     * @param {string} target Workspace-relative or absolute path.
     * @returns {boolean} `true` when the path exists.
     */
    exists(target) {
      return existsSync(absolute(target));
    },

    /**
     * Read file metadata.
     *
     * @param {string} target Workspace-relative or absolute path.
     * @returns {import('node:fs').Stats | null} Metadata, or `null` when unreadable.
     */
    stat(target) {
      try {
        return statSync(absolute(target));
      } catch {
        return null;
      }
    },

    /**
     * Read a UTF-8 text file.
     *
     * @param {string} target Workspace-relative or absolute path.
     * @returns {string | null} File contents, or `null` when unreadable.
     */
    readText(target) {
      try {
        return readFileSync(absolute(target), 'utf8');
      } catch {
        return null;
      }
    },

    /**
     * Read and parse a JSON file without throwing.
     *
     * @param {string} target Workspace-relative or absolute path.
     * @returns {{ok: boolean, value: any, error: string | null}} Parse outcome.
     */
    readJson(target) {
      const text = context.readText(target);
      if (text === null) return { ok: false, value: null, error: 'file is missing' };
      try {
        return { ok: true, value: JSON.parse(text), error: null };
      } catch (error) {
        return {
          ok: false,
          value: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    /**
     * List one directory level.
     *
     * @param {string} target Workspace-relative or absolute directory path.
     * @returns {{name: string, dir: boolean}[]} Entries sorted by name; empty when unreadable.
     */
    list(target) {
      try {
        return readdirSync(absolute(target), { withFileTypes: true })
          .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
          .sort((left, right) => left.name.localeCompare(right.name));
      } catch {
        return [];
      }
    },

    /**
     * Convert an absolute path to a workspace-relative POSIX path.
     *
     * @param {string} target Absolute path.
     * @returns {string} Workspace-relative path.
     */
    rel(target) {
      return relative(root, target).split(sep).join('/');
    },

    /**
     * Visit every file below a directory, depth first.
     *
     * @param {string} directory Workspace-relative directory.
     * @param {number} depth Remaining directory levels to descend.
     * @param {(path: string, stat: import('node:fs').Stats) => void} visit Called per file.
     * @returns {void}
     */
    walk(directory, depth, visit) {
      if (depth < 0) return;
      for (const entry of context.list(directory)) {
        const child = directory === '.' ? entry.name : `${directory}/${entry.name}`;
        if (entry.dir) {
          context.walk(child, depth - 1, visit);
          continue;
        }
        const metadata = context.stat(child);
        if (metadata) visit(child, metadata);
      }
    },
  };

  return context;
}
