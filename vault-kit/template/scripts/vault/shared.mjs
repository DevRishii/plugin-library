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
});

export const BUDGETS = Object.freeze({
  MOC_TOKENS: 400,
  BRIEF_DEFAULT_TOKENS: 1200,
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
export const DEFAULT_HANDOFFS_SUBDIR = '90-handoffs';
export const DEFAULT_SCHEMA_SUBDIR = '_schema';
export const DEFAULT_SRC_ROOTS = Object.freeze(['src', 'web', 'packages', 'config', 'scripts', 'tests']);

const FORBIDDEN_FLAG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class VaultError extends Error {
  /**
   * @param {number} exitCode
   * @param {string} code
   * @param {string} message
   */
  constructor(exitCode, code, message) {
    super(oneLine(message));
    this.name = 'VaultError';
    this.exitCode = exitCode;
    this.code = code;
  }
}

/** @param {unknown} text */
export function oneLine(text) {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deterministic token estimate: ceil(UTF-8 bytes / 4).
 * Always an estimate, never a tokenizer measurement.
 * @param {string} text
 */
export function estimateTokens(text) {
  const str = String(text ?? '');
  if (str.length === 0) return 0;
  return Math.ceil(Buffer.byteLength(str, 'utf8') / 4);
}

/** @param {string | Buffer} content */
export function sha256Hex(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * Canonical source_hash over sorted `path:hash` pairs of indexed files.
 * @param {Array<{ path: string, hash: string }>} files
 */
export function computeIndexSourceHash(files) {
  const pairs = files
    .map((entry) => `${toPosixPath(entry.path)}:${entry.hash}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(pairs.join('\n'));
}

/**
 * Normalize a relative path to POSIX `/` with no leading `./` or trailing `/`.
 * @param {string} inputPath
 */
export function toPosixPath(inputPath) {
  const normalized = String(inputPath ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/$/, '');
  return normalized === '' ? '.' : normalized;
}

/**
 * Resolve and validate the root directory, returning its realpath.
 * @param {string | undefined} rootFlag
 */
export function resolveRootDir(rootFlag) {
  const raw = typeof rootFlag === 'string' && rootFlag.trim().length > 0 ? rootFlag.trim() : process.cwd();
  if (raw.includes('\0')) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, 'invalid null byte in --root');
  }
  const candidate = resolve(raw);
  if (!existsSync(candidate)) {
    throw new VaultError(EXIT_CODES.NOT_FOUND, ERROR_CODES.NOT_FOUND, `root directory not found: ${raw}`);
  }
  const st = statSync(candidate);
  if (!st.isDirectory()) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `--root is not a directory: ${raw}`);
  }
  return realpathSync(candidate);
}

/**
 * Resolve a user-supplied path safely inside `rootReal`, rejecting lexical traversal
 * (`..`) and symlinks/junctions whose target escapes `rootReal`.
 * @param {string} rootReal
 * @param {string} targetInput
 * @returns { { absPath: string, relPosix: string } }
 */
export function resolveSafePath(rootReal, targetInput) {
  const raw = String(targetInput ?? '').trim();
  if (!raw || raw.includes('\0')) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, 'invalid empty or null-byte path');
  }
  if (raw.split(/[\\/]+/).includes('..')) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `path traversal rejected: ${raw}`);
  }
  const rootCanonical = realpathSync(rootReal);
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(rootCanonical, raw);

  if (!isWithinDir(rootCanonical, candidate)) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `path escapes root: ${raw}`);
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
      throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `symlink escapes root: ${raw}`);
    }
  }

  const rel = relative(rootCanonical, candidate);
  return {
    absPath: candidate,
    relPosix: rel === '' ? '.' : toPosixPath(rel),
  };
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

/**
 * Read a file Buffer after enforcing the 2 MB per-file size cap and symlink containment
 * BEFORE reading file bytes into memory.
 * @param {string} absPath
 * @param { { rootReal?: string, maxBytes?: number } } [options]
 */
export function readBoundedBuffer(absPath, options = {}) {
  const maxBytes = options.maxBytes ?? BUDGETS.MAX_FILE_BYTES;
  if (!existsSync(absPath)) {
    throw new VaultError(EXIT_CODES.NOT_FOUND, ERROR_CODES.NOT_FOUND, `file not found: ${absPath}`);
  }
  const lst = lstatSync(absPath);
  if (lst.isSymbolicLink() && options.rootReal) {
    const targetReal = realpathSync(absPath);
    if (!isWithinDir(realpathSync(options.rootReal), targetReal)) {
      throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, 'symlink target escapes root');
    }
  }
  const st = statSync(absPath);
  if (!st.isFile()) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `not a regular file: ${absPath}`);
  }
  if (st.size > maxBytes) {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.BUDGET_EXCEEDED,
      `file exceeds ${maxBytes}-byte cap (${st.size} bytes): ${absPath}`,
    );
  }
  return readFileSync(absPath);
}

/**
 * Read a UTF-8 file after enforcing the 2 MB per-file size cap and symlink containment.
 * @param {string} absPath
 * @param { { rootReal?: string, maxBytes?: number } } [options]
 */
export function readBoundedUtf8(absPath, options = {}) {
  return readBoundedBuffer(absPath, options).toString('utf8');
}

/**
 * Write UTF-8 LF text atomically (temp file + rename), stripping any leading BOM.
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

/**
 * Deterministic POSIX glob matcher (`**`, `*`, `?`, exact path, or `dir/**`).
 * @param {string} globPattern
 */
export function globToRegExp(globPattern) {
  const pat = toPosixPath(globPattern);
  let rx = '^';
  let i = 0;
  while (i < pat.length) {
    const ch = pat[i];
    if (ch === '*') {
      if (pat[i + 1] === '*') {
        if (pat[i + 2] === '/') {
          rx += '(?:.*/)?';
          i += 3;
        } else {
          rx += '.*';
          i += 2;
        }
      } else {
        rx += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      rx += '[^/]';
      i += 1;
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      rx += `\\${ch}`;
      i += 1;
    } else {
      rx += ch;
      i += 1;
    }
  }
  rx += '$';
  return new RegExp(rx);
}

/**
 * @param {string} relPosixPath
 * @param {string} globPattern
 */
export function matchesGlob(relPosixPath, globPattern) {
  return globToRegExp(globPattern).test(toPosixPath(relPosixPath));
}

/**
 * Specificity length used for `owner_slice` longest-match tie-breaking.
 * Counts non-wildcard characters in the normalized POSIX glob.
 * @param {string} globPattern
 */
export function globSpecificity(globPattern) {
  return toPosixPath(globPattern).replace(/[*?]/g, '').length;
}

/**
 * Parse CLI arguments into prototype-pollution-safe flags and positionals.
 * @param {string[]} argv
 */
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
      if (FORBIDDEN_FLAG_KEYS.has(rawKey) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(rawKey)) {
        throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `invalid flag: --${rawKey}`);
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
 * Emit structured success output (`{ "data": payload }` in `--json` mode, else humanText).
 * @param { { json: boolean, quiet: boolean } } ctx
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
 * Emit structured error output on stderr and return the exit code.
 * @param { { json?: boolean } } ctx
 * @param {string} code
 * @param {string} message
 * @param {number} exitCode
 */
export function emitFailure(ctx, code, message, exitCode) {
  const cleanMsg = oneLine(message);
  if (ctx?.json) {
    process.stderr.write(`${JSON.stringify({ error: { code, message: cleanMsg } })}\n`);
  } else {
    process.stderr.write(`error [${code}]: ${cleanMsg}\n`);
  }
  return exitCode;
}

/**
 * Print `tokens: <n> (estimate)` on stderr unless `--quiet` is active.
 * @param { { quiet?: boolean } } ctx
 * @param {number} tokens
 */
export function emitTokenNotice(ctx, tokens) {
  if (ctx?.quiet) return;
  process.stderr.write(`tokens: ${tokens} (estimate)\n`);
}

/**
 * Read and validate the optional `vault.config.json` in `rootReal`.
 * @param {string} rootReal
 */
export function readVaultConfig(rootReal) {
  const cfgPath = join(rootReal, 'vault.config.json');
  if (!existsSync(cfgPath)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readBoundedUtf8(cfgPath, { rootReal }));
  } catch (err) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `invalid vault.config.json: ${oneLine(err.message)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, 'vault.config.json must be an object');
  }
  for (const key of FORBIDDEN_FLAG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `forbidden key in vault.config.json: ${key}`);
    }
  }
  if (parsed.schema_version !== undefined && parsed.schema_version !== 1) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `unsupported vault.config.json schema_version: ${parsed.schema_version}`);
  }
  return parsed;
}

/**
 * Resolve vault-relative paths and source roots from config plus flags.
 * @param {string} rootReal
 * @param {Record<string, string | boolean>} [flags]
 */
export function resolveVaultLayout(rootReal, flags = {}) {
  const cfg = readVaultConfig(rootReal);
  let vaultDirRel = typeof cfg.vault_dir === 'string' && cfg.vault_dir.trim() ? cfg.vault_dir.trim() : DEFAULT_VAULT_DIR;
  if (typeof flags['vault-dir'] === 'string' && flags['vault-dir'].trim()) {
    vaultDirRel = flags['vault-dir'].trim();
  } else if (flags['vault-dir'] === true) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, '--vault-dir requires a path value');
  }
  const vaultSafe = resolveSafePath(rootReal, vaultDirRel);
  if (vaultSafe.relPosix === '.') {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, '--vault-dir cannot be the repository root');
  }
  let srcRoots = [...DEFAULT_SRC_ROOTS];
  if (Array.isArray(cfg.src_dirs)) {
    const cleaned = cfg.src_dirs
      .filter((item) => typeof item === 'string' && item.trim().length > 0)
      .map((item) => toPosixPath(item.trim()));
    if (cleaned.length > 0) srcRoots = cleaned;
  }
  return {
    vaultDirRel: vaultSafe.relPosix,
    vaultDirAbs: vaultSafe.absPath,
    indexRelPath: `${vaultSafe.relPosix}/.index/context-index.json`,
    schemaDirRel: `${vaultSafe.relPosix}/${DEFAULT_SCHEMA_SUBDIR}`,
    noteIdsRelPath: `${vaultSafe.relPosix}/${DEFAULT_SCHEMA_SUBDIR}/note-ids.json`,
    defaultRunsRelDir: `${vaultSafe.relPosix}/${DEFAULT_HANDOFFS_SUBDIR}`,
    srcRoots,
  };
}

/**
 * Resolve the handoff directory, honoring `--runs-dir` (a subdirectory name or a root-relative path).
 * @param {ReturnType<typeof resolveVaultLayout>} layout
 * @param {Record<string, string | boolean>} [flags]
 */
export function resolveRunsRelDir(layout, flags = {}) {
  const raw = flags['runs-dir'];
  if (raw === undefined) return layout.defaultRunsRelDir;
  if (raw === true) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, '--runs-dir requires a path value');
  }
  const text = toPosixPath(String(raw).trim());
  if (text === '.' || text === '') return layout.defaultRunsRelDir;
  if (text.includes('/')) return text;
  return `${layout.vaultDirRel}/${text}`;
}
