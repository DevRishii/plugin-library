#!/usr/bin/env node
/**
 * Shared Hivemind Context Vault + Model-Tier contracts (architect-locked).
 * Zero external dependencies; Node >= 20 ESM.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;

export const EXIT_CODES = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  VALIDATION: 2,
  NOT_FOUND: 3,
  STALE_INDEX: 4,
});

export const ERROR_CODES = Object.freeze({
  NOT_FOUND: 'not_found',
  STALE_INDEX: 'stale_index',
  INVALID_FRONTMATTER: 'invalid_frontmatter',
  BROKEN_LINK: 'broken_link',
  BUDGET_EXCEEDED: 'budget_exceeded',
  REFUSED: 'refused',
  INDEX_TOO_LARGE: 'index_too_large',
  TS_API_UNAVAILABLE: 'ts_api_unavailable',
  INTERNAL: 'internal',
  UNKNOWN_MODEL: 'unknown_model',
  TIER_VIOLATION: 'tier_violation',
  TEMPLATE_INVALID: 'template_invalid',
  STATE_CORRUPT: 'state_corrupt',
});

export const BUDGETS = Object.freeze({
  MOC_TOKENS: 400,
  BRIEF_DEFAULT_TOKENS: 1200,
  PRE_EXPLORATION_TOKENS: 1600,
  HANDOFF_BODY_TOKENS: 400,
  HANDOFF_MAX_BULLETS: 5,
  SLICE_MAX_LINES: 120,
  SLICE_ALLOW_LARGE_LINES: 200,
  SLICE_HEAD_LINES: 40,
  FIND_DEFAULT_LIMIT: 8,
  MAX_FILE_BYTES: 2 * 1024 * 1024,
  MAX_INDEX_SYMBOLS: 20000,
});

export const DEFAULT_VAULT_DIR = '.opencode/vault';
export const DEFAULT_SCRIPTS_DIR = 'scripts';
export const DEFAULT_HANDOFFS_SUBDIR = '90-handoffs';
export const LIFECYCLE_STATE_DIR = '.hive/lifecycle';

export const SENTINELS = Object.freeze({
  MOC_NOTE: '.opencode/vault/00-MOC.md',
  VAULT_CLI: 'scripts/vault.mjs',
});

export const VAULT_STATES = Object.freeze({
  ABSENT: 'absent',
  PARTIAL: 'partial',
  PRESENT_HEALTHY: 'present_healthy',
  PRESENT_UNHEALTHY: 'present_unhealthy',
});

export const PLAN_ACTIONS = Object.freeze({
  PROMPT_CREATE: 'prompt_create',
  PROMPT_UPDATE: 'prompt_update',
  NONE: 'none',
});

export const ALLOWED_PLACEHOLDERS = Object.freeze([
  'PROJECT_NAME',
  'PROJECT_ONE_LINER',
  'STACK',
  'SRC_DIRS',
  'TEST_CMD',
  'VAULT_DIR',
  'DATE',
]);

export const REQUIRED_NOTE_IDS = Object.freeze([
  { id: 'moc-root', type: 'moc', path: '.opencode/vault/00-MOC.md', stem_alias: '00-MOC' },
  { id: 'map-repo', type: 'map', path: '.opencode/vault/10-map/map-repo.md' },
  { id: 'map-layers', type: 'map', path: '.opencode/vault/10-map/map-layers.md' },
  { id: 'runbook-swarm-run', type: 'runbook', path: '.opencode/vault/40-runbooks/runbook-swarm-run.md' },
  { id: 'runbook-handoff', type: 'runbook', path: '.opencode/vault/40-runbooks/runbook-handoff.md' },
  { id: 'runbook-context-budget', type: 'runbook', path: '.opencode/vault/40-runbooks/runbook-context-budget.md' },
]);

export const AGENTS_VAULT_MARKERS = Object.freeze({
  BEGIN: '<!-- context-vault:begin -->',
  END: '<!-- context-vault:end -->',
});

export const GITIGNORE_REQUIRED_ENTRIES = Object.freeze([
  '.opencode/vault/.index/',
  '.opencode/vault/90-handoffs/',
  '.hive/',
]);

export const GOAL_ID_REGEX = /^[A-Za-z0-9._-]{1,64}$/;

export const QUESTION_FLOW_A = Object.freeze({
  header: 'Obsidian Context Vault',
  question:
    'This goal is complete and the project has no Obsidian context vault. Checkpoint the repo into one now? This creates .opencode/vault/ (L0 MOC, maps, contracts, slices, runbooks, 90-handoffs) plus the zero-dependency node scripts/vault.mjs CLI, a context-librarian agent, vault commands and AGENTS.md progressive-disclosure pointers.',
  options: Object.freeze([
    Object.freeze({
      label: 'Yes',
      description: 'Scaffold, index and require check --strict to pass. Roughly 2 minutes, no new dependencies.',
    }),
    Object.freeze({
      label: 'No',
      description: 'Skip for now. Nothing is written; you can run /vault-init later.',
    }),
  ]),
});

export const QUESTION_FLOW_B = Object.freeze({
  header: 'Refresh Context Vault',
  question:
    'This goal is complete and changed files the vault may not reflect. Update the Obsidian context vault now? Drifted pointer notes are refreshed, contracts and maps re-derived for changed paths, then index + check --strict must pass.',
  options: Object.freeze([
    Object.freeze({
      label: 'Yes',
      description: 'Refresh drifted notes, re-index, and require check --strict to pass.',
    }),
    Object.freeze({
      label: 'No',
      description: 'Skip the refresh. The vault stays as-is and /vault-refresh remains available.',
    }),
  ]),
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class HiveContractError extends Error {
  /**
   * @param {number} exitCode
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(exitCode, code, message, details) {
    super(oneLine(message));
    this.name = 'HiveContractError';
    this.exitCode = exitCode;
    this.code = code;
    if (details) this.details = details;
  }
}

export function getLibraryRoot() {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

/** @param {unknown} text */
export function oneLine(text) {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {string} text */
export function estimateTokens(text) {
  const str = String(text ?? '');
  if (str.length === 0) return 0;
  return Math.ceil(Buffer.byteLength(str, 'utf8') / 4);
}

/** @param {string | Buffer} content */
export function sha256Hex(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** @param {string} inputPath */
export function toPosixPath(inputPath) {
  const normalized = String(inputPath ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/$/, '');
  return normalized === '' ? '.' : normalized;
}

/**
 * @param {string} parentDir
 * @param {string} childPath
 */
export function isWithinDir(parentDir, childPath) {
  const p = process.platform === 'win32' ? parentDir.toLowerCase() : parentDir;
  const c = process.platform === 'win32' ? childPath.toLowerCase() : childPath;
  if (c === p) return true;
  const prefix = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(prefix);
}

/** @param {string | boolean | undefined} rootFlag */
export function resolveRootDir(rootFlag) {
  const raw = typeof rootFlag === 'string' && rootFlag.trim().length > 0 ? rootFlag.trim() : process.cwd();
  if (raw.includes('\0')) {
    throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, 'invalid null byte in --root');
  }
  const candidate = resolve(raw);
  if (!existsSync(candidate)) {
    throw new HiveContractError(EXIT_CODES.NOT_FOUND, ERROR_CODES.NOT_FOUND, `root directory not found: ${raw}`);
  }
  let st;
  try {
    st = statSync(candidate);
  } catch {
    throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `unreadable --root: ${raw}`);
  }
  if (!st.isDirectory()) {
    throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `--root is not a directory: ${raw}`);
  }
  return realpathSync(candidate);
}

/**
 * Resolve a relative or root-contained path safely, rejecting `..` escapes and escaping symlinks.
 * @param {string} rootReal
 * @param {string} targetInput
 * @param {string} [label]
 */
export function resolveSafePath(rootReal, targetInput, label = 'path') {
  const raw = String(targetInput ?? '').trim();
  if (!raw || raw.includes('\0')) {
    throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `invalid empty or null-byte ${label}`);
  }
  const segments = raw.split(/[\\/]+/);
  if (segments.includes('..')) {
    throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `path traversal rejected in ${label}: ${raw}`);
  }
  const rootCanonical = realpathSync(rootReal);
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(rootCanonical, raw);
  if (!isWithinDir(rootCanonical, candidate)) {
    throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `${label} escapes root: ${raw}`);
  }
  let probe = candidate;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (existsSync(probe)) {
    const probeReal = realpathSync(probe);
    if (!isWithinDir(rootCanonical, probeReal)) {
      throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `symlink escapes root in ${label}: ${raw}`);
    }
  }
  const rel = relative(rootCanonical, candidate);
  return {
    absPath: candidate,
    relPosix: rel === '' ? '.' : toPosixPath(rel),
  };
}

/** @param {unknown} goalId */
export function validateGoalId(goalId) {
  const value = String(goalId ?? '').trim();
  if (!GOAL_ID_REGEX.test(value) || value === '.' || value === '..' || value.includes('..')) {
    throw new HiveContractError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.REFUSED,
      `invalid --goal (expected ${GOAL_ID_REGEX}): ${value || '<empty>'}`,
    );
  }
  return value;
}

/**
 * Read optional `vault.config.json` from `rootReal`, validating `schema_version` and containment.
 * @param {string} rootReal
 * @param {string | boolean | undefined} vaultDirFlag
 */
export function resolveVaultLayout(rootReal, vaultDirFlag) {
  let vaultDirRel = DEFAULT_VAULT_DIR;
  let scriptsDirRel = DEFAULT_SCRIPTS_DIR;
  const cfgPath = join(rootReal, 'vault.config.json');
  if (existsSync(cfgPath)) {
    const text = readBoundedUtf8(cfgPath, { rootReal });
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new HiveContractError(
        EXIT_CODES.VALIDATION,
        ERROR_CODES.REFUSED,
        `invalid vault.config.json: ${err.message}`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, 'vault.config.json must be an object');
    }
    for (const k of FORBIDDEN_KEYS) {
      if (Object.prototype.hasOwnProperty.call(parsed, k)) {
        throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `forbidden key in vault.config.json: ${k}`);
      }
    }
    if (parsed.schema_version !== undefined && parsed.schema_version !== SCHEMA_VERSION) {
      throw new HiveContractError(
        EXIT_CODES.VALIDATION,
        ERROR_CODES.REFUSED,
        `unsupported vault.config.json schema_version: ${parsed.schema_version}`,
      );
    }
    if (typeof parsed.vault_dir === 'string' && parsed.vault_dir.trim()) {
      vaultDirRel = parsed.vault_dir.trim();
    }
    if (typeof parsed.scripts_dir === 'string' && parsed.scripts_dir.trim()) {
      scriptsDirRel = parsed.scripts_dir.trim();
    }
  }
  if (typeof vaultDirFlag === 'string' && vaultDirFlag.trim()) {
    vaultDirRel = vaultDirFlag.trim();
  } else if (vaultDirFlag === true) {
    throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, '--vault-dir requires a path value');
  }
  const vaultSafe = resolveSafePath(rootReal, vaultDirRel, '--vault-dir');
  if (vaultSafe.relPosix === '.') {
    throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, '--vault-dir cannot be the repository root');
  }
  const scriptsSafe = resolveSafePath(rootReal, scriptsDirRel, 'scripts_dir');
  const mocSafe = resolveSafePath(rootReal, `${vaultSafe.relPosix}/00-MOC.md`, 'moc_sentinel');
  const cliSafe = resolveSafePath(rootReal, `${scriptsSafe.relPosix}/vault.mjs`, 'cli_sentinel');
  return {
    vaultDirAbs: vaultSafe.absPath,
    vaultDirRel: vaultSafe.relPosix,
    scriptsDirAbs: scriptsSafe.absPath,
    scriptsDirRel: scriptsSafe.relPosix,
    mocSentinelAbs: mocSafe.absPath,
    mocSentinelRel: mocSafe.relPosix,
    cliSentinelAbs: cliSafe.absPath,
    cliSentinelRel: cliSafe.relPosix,
  };
}

/**
 * @param {string} absPath
 * @param {{ rootReal?: string, maxBytes?: number }} [options]
 */
export function readBoundedUtf8(absPath, options = {}) {
  const maxBytes = options.maxBytes ?? BUDGETS.MAX_FILE_BYTES;
  if (!existsSync(absPath)) {
    throw new HiveContractError(EXIT_CODES.NOT_FOUND, ERROR_CODES.NOT_FOUND, `file not found: ${absPath}`);
  }
  const lst = lstatSync(absPath);
  if (lst.isSymbolicLink() && options.rootReal) {
    const targetReal = realpathSync(absPath);
    if (!isWithinDir(realpathSync(options.rootReal), targetReal)) {
      throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, 'symlink target escapes root');
    }
  }
  const st = statSync(absPath);
  if (!st.isFile()) {
    throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `not a regular file: ${absPath}`);
  }
  if (st.size > maxBytes) {
    throw new HiveContractError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.BUDGET_EXCEEDED,
      `file exceeds ${maxBytes}-byte cap (${st.size} bytes)`,
    );
  }
  return readFileSync(absPath, 'utf8');
}

/**
 * @param {string} absPath
 * @param {string} content
 */
export function atomicWriteUtf8(absPath, content) {
  const clean = String(content ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');
  mkdirSync(dirname(absPath), { recursive: true });
  const tmpPath = join(dirname(absPath), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    writeFileSync(tmpPath, clean, { encoding: 'utf8' });
    renameSync(tmpPath, absPath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

/** @param {string[]} argv */
export function parseCliArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = Object.create(null);
  /** @type {string[]} */
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--') && token.length > 2) {
      const eqIdx = token.indexOf('=');
      let rawKey;
      /** @type {string | boolean} */
      let value;
      if (eqIdx !== -1) {
        rawKey = token.slice(2, eqIdx);
        value = token.slice(eqIdx + 1);
      } else {
        rawKey = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i += 1;
        } else {
          value = true;
        }
      }
      if (FORBIDDEN_KEYS.has(rawKey) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(rawKey)) {
        throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `invalid flag: --${rawKey}`);
      }
      flags[rawKey] = value;
    } else if (token === '-h') {
      flags.help = true;
    } else if (token === '-q') {
      flags.quiet = true;
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

/**
 * @param {{ json?: boolean, quiet?: boolean }} ctx
 * @param {unknown} payload
 * @param {string} [humanText]
 */
export function emitSuccess(ctx, payload, humanText) {
  if (ctx?.json) {
    process.stdout.write(`${JSON.stringify({ data: payload })}\n`);
    return;
  }
  if (ctx?.quiet) return;
  if (humanText !== undefined) {
    const out = humanText.endsWith('\n') ? humanText : `${humanText}\n`;
    process.stdout.write(out);
  } else {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
}

/**
 * @param {{ json?: boolean }} ctx
 * @param {string} code
 * @param {string} message
 * @param {number} exitCode
 * @param {Record<string, unknown>} [extraData]
 */
export function emitFailure(ctx, code, message, exitCode, extraData) {
  const cleanMsg = oneLine(message);
  if (ctx?.json) {
    const body = extraData
      ? { error: { code, message: cleanMsg }, data: extraData }
      : { error: { code, message: cleanMsg } };
    process.stderr.write(`${JSON.stringify(body)}\n`);
  } else {
    process.stderr.write(`error [${code}]: ${cleanMsg}\n`);
  }
  return exitCode;
}

export function isCiEnvironment(env = process.env) {
  const raw = String(env?.CI ?? '').trim().toLowerCase();
  return raw !== '' && raw !== '0' && raw !== 'false';
}

function runSelfCheck() {
  if (EXIT_CODES.OK !== 0 || EXIT_CODES.STALE_INDEX !== 4) {
    throw new Error('EXIT_CODES contract mismatch');
  }
  if (ALLOWED_PLACEHOLDERS.length !== 7) {
    throw new Error('ALLOWED_PLACEHOLDERS count mismatch');
  }
  if (QUESTION_FLOW_A.options[0].label !== 'Yes' || QUESTION_FLOW_A.options[1].label !== 'No') {
    throw new Error('QUESTION_FLOW_A labels mismatch');
  }
  if (QUESTION_FLOW_B.options[0].label !== 'Yes' || QUESTION_FLOW_B.options[1].label !== 'No') {
    throw new Error('QUESTION_FLOW_B labels mismatch');
  }
  if (estimateTokens('abcd') !== 1) {
    throw new Error('estimateTokens mismatch');
  }
  process.stdout.write(`${JSON.stringify({ data: { ok: true, schema_version: SCHEMA_VERSION } })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--self-check')) {
    runSelfCheck();
    process.exit(EXIT_CODES.OK);
  }
}
