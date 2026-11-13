import { spawnSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the CLI under test, resolved from this helper's own URL. */
const CLI_PATH = fileURLToPath(new URL('../bin/dsh-doctor.mjs', import.meta.url));

/**
 * Create a throwaway workspace below the OS temporary directory.
 *
 * `files` maps workspace-relative paths to text content. Parent directories are
 * created automatically. A `null` value (for example `{ 'empty-dir': null }`)
 * creates an empty directory; the optional second argument lists additional
 * empty directories.
 *
 * @param {Record<string, string | null>} [files] Relative path to content map.
 * @param {string[]} [emptyDirs] Extra directories to create empty.
 * @returns {string} Absolute workspace root.
 */
export function makeWorkspace(files = {}, emptyDirs = []) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-doctor-test-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    if (content === null || content === undefined) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, String(content), 'utf8');
  }
  for (const directory of emptyDirs) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  return root;
}

/**
 * Run the CLI synchronously and capture its output.
 *
 * The primary path matches the documented contract: spawn with pipes and
 * `encoding: 'utf8'`. Some confined Windows environments forbid the named pipes
 * that `spawnSync` uses for standard streams, so on `EPERM` the same child is
 * re-run with its streams redirected to temporary files, which keeps the
 * helper's `{status, stdout, stderr}` contract intact.
 *
 * @param {string[]} args CLI arguments after the script name.
 * @param {{cwd?: string}} [options] Spawn options.
 * @returns {{status: number | null, stdout: string, stderr: string}} Process result.
 */
export function runCli(args, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const argv = [CLI_PATH, ...args];
  const result = spawnSync(process.execPath, argv, { cwd, encoding: 'utf8' });
  if (!result.error) {
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
  if (result.error.code !== 'EPERM') throw result.error;
  return runCliThroughFiles(argv, cwd);
}

/**
 * Fallback for environments that deny anonymous pipes: redirect the child's
 * stdout and stderr to temporary files instead.
 *
 * @param {string[]} argv Node arguments including the CLI path.
 * @param {string} cwd Working directory.
 * @returns {{status: number | null, stdout: string, stderr: string}} Process result.
 */
function runCliThroughFiles(argv, cwd) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-doctor-cli-'));
  const stdoutPath = join(directory, 'stdout.txt');
  const stderrPath = join(directory, 'stderr.txt');
  try {
    const stdoutFd = openSync(stdoutPath, 'w');
    const stderrFd = openSync(stderrPath, 'w');
    let result;
    try {
      result = spawnSync(process.execPath, argv, {
        cwd,
        stdio: ['ignore', stdoutFd, stderrFd],
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
    if (result.error) throw result.error;
    return {
      status: result.status,
      stdout: readFileSync(stdoutPath, 'utf8'),
      stderr: readFileSync(stderrPath, 'utf8'),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Parse a CLI result's stdout as JSON, failing with the captured output when it
 * is not JSON.
 *
 * @param {{stdout: string, stderr?: string} | string} result CLI result or raw text.
 * @returns {any} Parsed JSON value.
 */
export function readJsonOutput(result) {
  const text = typeof result === 'string' ? result : result.stdout;
  try {
    return JSON.parse(text);
  } catch (error) {
    const stderr = typeof result === 'string' ? '' : (result.stderr ?? '');
    throw new Error(
      `expected JSON on stdout but parsing failed: ${error instanceof Error ? error.message : String(error)}\n` +
        `--- stdout ---\n${text}\n--- stderr ---\n${stderr}`,
    );
  }
}

/**
 * Index a report's findings by check id.
 *
 * @param {object | string | {stdout: string, stderr?: string}} reportOrOutput Report, JSON text, or CLI result.
 * @returns {Map<string, object>} Check id to finding.
 */
export function findingsById(reportOrOutput) {
  let report = reportOrOutput;
  if (typeof report === 'string') report = JSON.parse(report);
  else if (report && typeof report.stdout === 'string') report = readJsonOutput(report);
  if (!report || !Array.isArray(report.findings)) {
    throw new Error('findingsById expected a report with a findings array');
  }
  return new Map(report.findings.map((finding) => [finding.id, finding]));
}

/**
 * Snapshot every file below a directory as sorted relative path plus content.
 *
 * The array is deeply comparable, so a test can prove a run wrote nothing.
 *
 * @param {string} root Workspace root.
 * @returns {{path: string, content: string}[]} Sorted snapshot.
 */
export function snapshotTree(root) {
  const files = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({
        path: relative(root, absolute).split(sep).join('/'),
        content: readFileSync(absolute, 'utf8'),
      });
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Remove a workspace created by {@link makeWorkspace}.
 *
 * @param {string} root Workspace root.
 * @returns {void}
 */
export function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}
