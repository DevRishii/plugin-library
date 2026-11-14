#!/usr/bin/env node
/**
 * Shared helpers for the executable Hivemind context-vault end-to-end tests.
 *
 * The tests copy a tiny committed fixture repository into an OS temp directory,
 * invoke the real CLIs with `process.execPath`, assert on JSON envelopes, and
 * clean up the temp tree with `t.after`. No machine-specific path is ever
 * written into a fixture or a snapshot.
 *
 * The `question` tool boundary is intentionally represented by
 * `toQuestionToolPayload`: DECISIONS D3 wraps one `{ header, question, options }`
 * item emitted by `vault-prompt.mjs` / `vault-lifecycle.mjs plan` in
 * `{ questions: [item] }`.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LIFECYCLE_CLI = join(REPO_ROOT, 'scripts', 'hive', 'vault-lifecycle.mjs');
export const MODEL_TIER_CLI = join(REPO_ROOT, 'scripts', 'hive', 'model-tier.mjs');
export const FRESH_REPO_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'e2e', 'fresh-repo');

/** @param {string} value */
function toPosixPath(value) {
  return String(value).replaceAll('\\', '/');
}

/** @param {string} label */
function safeLabel(label) {
  return String(label).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'repo';
}

/**
 * Copy the committed fresh-repo fixture into a uniquely named OS temp tree.
 * The caller's test context owns cleanup.
 *
 * @param {{ after: (callback: () => void) => void }} t
 * @param {string} [label]
 * @returns {string} absolute repository root
 */
export function createFreshRepo(t, label = 'checkpoint') {
  const parent = mkdtempSync(join(tmpdir(), `hive-e2e-${safeLabel(label)}-`));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'repo');
  cpSync(FRESH_REPO_FIXTURE, root, { recursive: true });
  return root;
}

/** @param {ReturnType<typeof spawnSync>} result */
function parseBody(result) {
  const stdout = String(result.stdout ?? '').trim();
  const stderr = String(result.stderr ?? '').trim();
  const text = stdout || stderr;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line.startsWith('{') || !line.endsWith('}')) continue;
      try {
        return JSON.parse(line);
      } catch {
        // Keep scanning for a final JSON line.
      }
    }
    return null;
  }
}

/**
 * Invoke one CLI as a child process with deterministic assertions.
 *
 * @param {string} cliPath
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, timeout?: number }} [options]
 */
export function runCli(cliPath, args, options = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    timeout: options.timeout ?? 120000,
    shell: false,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      CI: '',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      ...(options.env ?? {}),
    },
  });
  return { ...result, body: parseBody(result) };
}

/**
 * Run the lifecycle CLI with `--root <root> --json` appended.
 *
 * @param {string} root
 * @param {string[]} args
 * @param {{ env?: Record<string, string | undefined> }} [options]
 */
export function runLifecycle(root, args, options = {}) {
  return runCli(LIFECYCLE_CLI, [...args, '--root', root, '--json'], {
    cwd: root,
    env: options.env,
  });
}

/**
 * Run the model-tier CLI with `--json` appended.
 *
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string | undefined> }} [options]
 */
export function runModelTier(args, options = {}) {
  return runCli(MODEL_TIER_CLI, [...args, '--json'], {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env,
  });
}

/**
 * Assert a successful `{ data: ... }` envelope and return its data.
 *
 * @param {ReturnType<typeof runCli>} run
 */
export function dataOf(run) {
  if (run.status !== 0) {
    throw new Error(
      `expected exit 0, received ${String(run.status)}\nstdout: ${String(run.stdout ?? '').trim()}\nstderr: ${String(run.stderr ?? '').trim()}`,
    );
  }
  if (!run.body || typeof run.body !== 'object' || !('data' in run.body)) {
    throw new Error(`expected a { data } JSON envelope, received: ${String(run.stdout ?? '').trim()}`);
  }
  return run.body.data;
}

/**
 * Wrap one `vault-lifecycle.mjs plan` question item in the OpenCode tool
 * boundary shape documented in DECISIONS D3.
 *
 * @param {{ header: string, question: string, options: { label: string, description: string }[] }} item
 * @returns {{ questions: { header: string, question: string, options: { label: string, description: string }[] }[] }}
 */
export function toQuestionToolPayload(item) {
  if (!item || typeof item !== 'object') throw new TypeError('question item must be an object');
  if (typeof item.header !== 'string' || typeof item.question !== 'string') {
    throw new TypeError('question item must carry string header and question fields');
  }
  if (!Array.isArray(item.options)) throw new TypeError('question item must carry an options array');
  return {
    questions: [
      {
        header: item.header,
        question: item.question,
        options: item.options.map((option) => ({
          label: option.label,
          description: option.description,
        })),
      },
    ],
  };
}

/**
 * Capture a deterministic content snapshot of a directory. Relative paths are
 * POSIX-normalized and file contents are base64 so CRLF differences stay
 * observable without depending on the host separator.
 *
 * @param {string} root
 * @param {{ exclude?: string[] }} [options]
 * @returns {Record<string, string>}
 */
export function snapshotTree(root, options = {}) {
  const exclude = new Set((options.exclude ?? []).map(toPosixPath));
  const files = {};
  const isExcluded = (rel) => {
    for (const entry of exclude) {
      if (rel === entry || rel.startsWith(`${entry}/`)) return true;
    }
    return false;
  };

  /** @param {string} absDir @param {string} relDir */
  const walk = (absDir, relDir) => {
    const entries = readdirSync(absDir, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = toPosixPath(relDir === '' ? entry.name : `${relDir}/${entry.name}`);
      if (isExcluded(rel)) continue;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        files[rel] = readFileSync(abs).toString('base64');
      }
    }
  };

  walk(root, '');
  return files;
}

/**
 * Read a UTF-8 file relative to a repository root.
 * @param {string} root @param {string} rel
 */
export function readRepoFile(root, rel) {
  return readFileSync(join(root, ...toPosixPath(rel).split('/')), 'utf8');
}

/**
 * Relative-to-root POSIX path helper for assertions and error messages.
 * @param {string} root @param {string} abs
 */
export function relativePosix(root, abs) {
  return toPosixPath(relative(root, abs));
}
