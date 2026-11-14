#!/usr/bin/env node
/**
 * Obsidian Context Vault detection and health state machine.
 *
 * Resolves the two vault sentinels (the L0 MOC note and the zero-dependency
 * vault CLI), then reports one of four deterministic states. Detection is
 * strictly read-only: this module never creates, modifies, indexes or deletes
 * files. The vault CLI is only spawned in read-only modes (`check --strict
 * --json` and `stats --json`) with an argv array and `shell: false`.
 *
 * Usage:
 *   node scripts/hive/vault-detect.mjs --root <dir> [--vault-dir <dir>] [--json] [--quiet]
 *
 * Zero external dependencies; Node >= 20 ESM.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ERROR_CODES,
  EXIT_CODES,
  HiveContractError,
  VAULT_STATES,
  emitFailure,
  emitSuccess,
  parseCliArgs,
  readBoundedUtf8,
  resolveRootDir,
  resolveVaultLayout,
  toPosixPath,
} from './contracts.mjs';

/** Deterministic placeholder stats used whenever no index is available. */
export const EMPTY_STATS = Object.freeze({ notes: 0, symbols: 0, index_status: 'missing' });

/** Reported when the vault CLI fails without a typed `error.code` on stderr. */
const FALLBACK_CHECK_ERROR = 'validation_failed';
const CLI_TIMEOUT_MS = 15000;

const USAGE = [
  'Usage: node scripts/hive/vault-detect.mjs --root <dir> [--vault-dir <dir>] [--json] [--quiet]',
  '',
  'Detect an Obsidian context vault and report its health. Read-only; never writes.',
  '',
  'Options:',
  '  --root <dir>       repository root to inspect (required)',
  '  --vault-dir <dir>  vault directory relative to the root (default .opencode/vault)',
  '  --json             emit a single JSON document on stdout',
  '  --quiet            suppress human-readable output',
  '  --help, -h         show this help text',
].join('\n');

/**
 * @param {string} absPath
 * @returns {boolean}
 */
function isRegularFile(absPath) {
  try {
    return statSync(absPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Render an absolute path with forward slashes, preserving a drive/root slash.
 * @param {string} absPath
 * @returns {string}
 */
function posixAbsolutePath(absPath) {
  const normalized = toPosixPath(absPath);
  const hadTrailingSeparator = /[\\/]$/.test(absPath);
  return hadTrailingSeparator && !normalized.endsWith('/') ? `${normalized}/` : normalized;
}

/**
 * Parse the minimal frontmatter contract: a leading `---` block carrying
 * non-empty `id` and `title` scalars.
 * @param {string} text
 * @returns {{ id: string, title: string } | null}
 */
function parseFrontmatter(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  if (lines[0] !== '---') return null;
  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      closing = index;
      break;
    }
  }
  if (closing === -1) return null;
  const fields = new Map();
  for (const rawLine of lines.slice(1, closing)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1).trim();
      }
    }
    if (!value || value === '~' || value === 'null') continue;
    if (!fields.has(key)) fields.set(key, value);
  }
  const id = String(fields.get('id') ?? '').trim();
  const title = String(fields.get('title') ?? '').trim();
  if (!id || !title) return null;
  return { id, title };
}

/**
 * @param {string} absPath
 * @param {string} rootReal
 * @returns {{ id: string, title: string } | null}
 */
function readFrontmatter(absPath, rootReal) {
  try {
    return parseFrontmatter(readBoundedUtf8(absPath, { rootReal }));
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
function parseJsonCandidate(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // fall through to per-line scanning
  }
  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // keep scanning earlier lines
    }
  }
  return null;
}

/**
 * @param {string} stderr
 * @returns {string | null}
 */
function parseStderrErrorCode(stderr) {
  const parsed = parseJsonCandidate(stderr);
  const code = parsed?.error?.code;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.trunc(numeric);
}

/**
 * @param {string} stdout
 * @returns {{ notes: number, symbols: number, index_status: string }}
 */
function normalizeStats(stdout) {
  const parsed = parseJsonCandidate(stdout);
  const payload = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : null;
  if (!payload) return { ...EMPTY_STATS };
  const indexStatus = typeof payload.index_status === 'string' && payload.index_status.trim()
    ? payload.index_status.trim()
    : EMPTY_STATS.index_status;
  return {
    notes: toCount(payload.notes),
    symbols: toCount(payload.symbols),
    index_status: indexStatus,
  };
}

/**
 * @param {string} cliAbs
 * @param {string[]} args
 * @param {string} rootReal
 */
function runVaultCli(cliAbs, args, rootReal) {
  return spawnSync(process.execPath, [cliAbs, ...args], {
    cwd: rootReal,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    shell: false,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

/**
 * @param {number | null | undefined} status
 * @returns {number}
 */
function normalizeExitCode(status) {
  return typeof status === 'number' && status >= 0 ? status : 1;
}

/**
 * @param {Record<string, any>} data
 * @returns {string}
 */
function humanSummary(data) {
  const sentinels = data.sentinels.map((entry) => `${entry.path}=${entry.exists ? 'yes' : 'no'}`).join(', ');
  const errorSuffix = data.health.error_code ? ` error=${data.health.error_code}` : '';
  return [
    `vault state: ${data.state}`,
    `root: ${data.repo_root}`,
    `vault dir: ${data.vault_dir}`,
    `sentinels: ${sentinels}`,
    `health: exit=${data.health.exit_code}${errorSuffix}`,
    `stats: notes=${data.stats.notes} symbols=${data.stats.symbols} index=${data.stats.index_status}`,
  ].join('\n');
}

/**
 * Resolve both sentinels and derive the vault state without writing anything.
 * @param {{ root?: string, vaultDir?: string }} [options]
 * @returns {{
 *   repo_root: string,
 *   vault_dir: string,
 *   state: string,
 *   sentinels: Array<{ path: string, exists: boolean }>,
 *   missing: string[],
 *   health: { exit_code: number, error_code: string | null },
 *   stats: { notes: number, symbols: number, index_status: string },
 * }}
 */
export function detectVault(options = {}) {
  const rootReal = resolveRootDir(options?.root);
  const layout = resolveVaultLayout(rootReal, options?.vaultDir);

  const mocExists = isRegularFile(layout.mocSentinelAbs);
  const cliExists = isRegularFile(layout.cliSentinelAbs);

  const sentinels = [
    { path: layout.mocSentinelRel, exists: mocExists },
    { path: layout.cliSentinelRel, exists: cliExists },
  ];
  const missing = sentinels.filter((entry) => !entry.exists).map((entry) => entry.path);

  let state = VAULT_STATES.ABSENT;
  let health = { exit_code: EXIT_CODES.OK, error_code: null };
  let stats = { ...EMPTY_STATS };

  if (!mocExists && !cliExists) {
    state = VAULT_STATES.ABSENT;
  } else if (!mocExists || !cliExists) {
    state = VAULT_STATES.PARTIAL;
  } else {
    const frontmatter = readFrontmatter(layout.mocSentinelAbs, rootReal);
    if (!frontmatter) {
      state = VAULT_STATES.PARTIAL;
      health = { exit_code: EXIT_CODES.VALIDATION, error_code: ERROR_CODES.INVALID_FRONTMATTER };
    } else {
      const checkRun = runVaultCli(
        layout.cliSentinelAbs,
        ['check', '--strict', '--json', '--root', rootReal, '--vault-dir', layout.vaultDirRel],
        rootReal,
      );
      const checkExit = normalizeExitCode(checkRun.status);
      if (checkExit === EXIT_CODES.OK) {
        state = VAULT_STATES.PRESENT_HEALTHY;
        health = { exit_code: EXIT_CODES.OK, error_code: null };
      } else {
        state = VAULT_STATES.PRESENT_UNHEALTHY;
        health = {
          exit_code: checkExit,
          error_code: parseStderrErrorCode(checkRun.stderr) ?? FALLBACK_CHECK_ERROR,
        };
      }
    }
    const statsRun = runVaultCli(layout.cliSentinelAbs, ['stats', '--json', '--root', rootReal, '--vault-dir', layout.vaultDirRel], rootReal);
    stats = normalizeStats(statsRun.stdout);
  }

  return {
    repo_root: posixAbsolutePath(rootReal),
    vault_dir: layout.vaultDirRel,
    state,
    sentinels,
    missing,
    health,
    stats,
  };
}

/**
 * @param {string} metaUrl
 * @returns {boolean}
 */
function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const selfPath = fileURLToPath(metaUrl);
  const samePath = (left, right) =>
    process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  try {
    return samePath(realpathSync(resolve(entry)), realpathSync(selfPath));
  } catch {
    return samePath(resolve(entry), selfPath);
  }
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function runMain(argv) {
  const ctx = { json: argv.includes('--json'), quiet: argv.includes('--quiet') || argv.includes('-q') };
  try {
    const { flags } = parseCliArgs(argv);
    if (flags.help === true) {
      if (!ctx.quiet) process.stdout.write(`${USAGE}\n`);
      return EXIT_CODES.OK;
    }
    const rootFlag = flags.root;
    if (typeof rootFlag !== 'string' || rootFlag.trim() === '') {
      return emitFailure(ctx, ERROR_CODES.NOT_FOUND, 'missing required --root <dir>', EXIT_CODES.NOT_FOUND);
    }
    const data = detectVault({ root: rootFlag, vaultDir: flags['vault-dir'] });
    emitSuccess(ctx, data, humanSummary(data));
    return EXIT_CODES.OK;
  } catch (error) {
    if (error instanceof HiveContractError) {
      return emitFailure(ctx, error.code, error.message, error.exitCode);
    }
    const message = error instanceof Error ? error.message : String(error);
    return emitFailure(ctx, ERROR_CODES.INTERNAL, message, EXIT_CODES.INTERNAL);
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runMain(process.argv.slice(2));
}
