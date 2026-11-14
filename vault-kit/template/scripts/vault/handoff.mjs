import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  ERROR_CODES,
  EXIT_CODES,
  VaultError,
  atomicWriteUtf8,
  emitSuccess,
  emitTokenNotice,
  estimateTokens,
  readBoundedUtf8,
  resolveRunsRelDir,
  resolveSafePath,
  toPosixPath,
} from './shared.mjs';
import {
  HANDOFF_STATUSES,
  NOTE_OWNERS,
  buildHandoffId,
  parseNote,
  serializeNote,
} from './frontmatter.mjs';

const RUN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]|\.[A-Za-z0-9_-]){0,39}$/;
const SLICE_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;

/**
 * Read a `--stdin` JSON payload when the flag is a boolean or a JSON string.
 * @param {string | boolean | undefined} stdinFlag
 * @returns {Record<string, unknown>}
 */
function readStdinPayload(stdinFlag) {
  if (stdinFlag === undefined) return {};
  let raw;
  if (typeof stdinFlag === 'string') {
    raw = stdinFlag;
  } else if (stdinFlag === true) {
    raw = readFileSync(0, 'utf8');
  } else {
    return {};
  }
  if (raw.trim() === '') {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.INVALID_FRONTMATTER, 'empty --stdin JSON payload');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.INVALID_FRONTMATTER, 'invalid --stdin JSON payload');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.INVALID_FRONTMATTER, '--stdin JSON must be an object');
  }
  return parsed;
}

/**
 * Flags win over `--stdin` fields when both are present.
 * @param {unknown} flagValue
 * @param {unknown} stdinValue
 * @returns {unknown}
 */
function pick(flagValue, stdinValue) {
  return flagValue === undefined ? stdinValue : flagValue;
}

/**
 * Normalize a comma-separated list flag without splitting a full command string.
 * @param {unknown} value
 * @returns {string[]}
 */
function parseListValue(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
  }
  const text = String(value);
  if (!text.includes(',')) {
    const single = text.trim();
    return single.length > 0 ? [single] : [];
  }
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Normalize a handoff body to bullet-only lines, rejecting code blocks and diffs.
 * @param {unknown} rawBody
 * @param {string} status
 * @param {string} slice
 * @returns {string}
 */
function normalizeHandoffBody(rawBody, status, slice) {
  const provided = typeof rawBody === 'string' && rawBody.trim().length > 0;
  const text = provided ? String(rawBody) : `- status: ${status} for ${slice}`;

  if (/^\s*(?:```|~~~)/m.test(text)) {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.INVALID_FRONTMATTER,
      'handoff body must not contain fenced code blocks',
    );
  }
  if (/(^|\n)\s*diff --git\b/.test(text) || /(^|\n)\s*@@\s/.test(text)) {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.INVALID_FRONTMATTER,
      'handoff body must not contain raw diff headers',
    );
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (/^-\s+/.test(line) ? line : `- ${line}`));

  if (lines.length > 5) {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.BUDGET_EXCEEDED,
      `handoff body exceeds 5 bullets (${lines.length})`,
    );
  }

  return lines.join('\n');
}

/** @param {number} n */
function bulletCount(body) {
  const lines = String(body ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  return lines.filter((line) => /^\s*-\s+/.test(line)).length;
}

/**
 * Write a validated run handoff note under `40-runs/<run>/<slice>.handoff.md`.
 * @param { { root: string, flags: Record<string, string | boolean>, positionals: string[], json: boolean, quiet: boolean } } ctx
 * @returns {Promise<number>}
 */
export async function writeHandoff(ctx) {
  const runsRelDir = resolveRunsRelDir(ctx.layout, ctx.flags);
  const stdin = readStdinPayload(ctx.flags.stdin);

  const runRaw = pick(ctx.flags.run, stdin.run);
  const sliceRaw = pick(ctx.flags.slice, stdin.slice);
  const statusRaw = pick(ctx.flags.status, stdin.status);
  const ownerRaw = pick(ctx.flags.owner, stdin.owner);
  const titleRaw = pick(ctx.flags.title, stdin.title);

  const run = runRaw === undefined ? '' : String(runRaw);
  const slice = sliceRaw === undefined ? '' : String(sliceRaw);
  const status = statusRaw === undefined ? '' : String(statusRaw);
  const owner = ownerRaw === undefined ? 'builder' : String(ownerRaw);

  if (!RUN_PATTERN.test(run)) {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.INVALID_FRONTMATTER,
      `invalid or missing --run (expected ${RUN_PATTERN.source}, max 40 chars)`,
    );
  }
  if (!SLICE_PATTERN.test(slice)) {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.INVALID_FRONTMATTER,
      `invalid or missing --slice (expected ^[a-z][a-z0-9-]{2,63}$)`,
    );
  }
  if (!HANDOFF_STATUSES.includes(status)) {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.INVALID_FRONTMATTER,
      `invalid or missing --status (expected ${HANDOFF_STATUSES.join('|')})`,
    );
  }
  if (!NOTE_OWNERS.includes(owner)) {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.INVALID_FRONTMATTER,
      `invalid --owner (expected ${NOTE_OWNERS.join('|')})`,
    );
  }

  const relPosix = `${runsRelDir}/${run}/${slice}.handoff.md`;
  const target = resolveSafePath(ctx.root, relPosix);
  if (!target.relPosix.startsWith(`${runsRelDir}/`) || run.includes('..') || run.length > 40) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `handoff path escapes ${runsRelDir}: ${run}`);
  }

  if (existsSync(target.absPath)) {
    const existing = parseNote(readBoundedUtf8(target.absPath, { rootReal: ctx.root }), { filePath: relPosix });
    if (existing.frontmatter.status === 'done') {
      throw new VaultError(
        EXIT_CODES.NOT_FOUND,
        ERROR_CODES.REFUSED,
        `cannot overwrite completed handoff: ${run}/${slice}`,
      );
    }
  }

  const title = titleRaw === undefined || String(titleRaw).trim() === '' ? `${slice} handoff` : String(titleRaw);
  const filesChanged = parseListValue(pick(ctx.flags.files, stdin.files_changed));
  const testsRun = parseListValue(pick(ctx.flags.tests, stdin.tests_run));
  const decisions = parseListValue(pick(ctx.flags.decisions, stdin.decisions));
  const blockers = parseListValue(pick(ctx.flags.blockers, stdin.blockers));

  const body = normalizeHandoffBody(pick(ctx.flags.body, stdin.body), status, slice);

  /** @type {Record<string, string | string[]>} */
  const frontmatter = {
    id: buildHandoffId(run, slice),
    title,
    type: 'handoff',
    status,
    owner,
    run,
    slice,
    files_changed: filesChanged,
    tests_run: testsRun,
    decisions,
    blockers,
    updated: new Date().toISOString().slice(0, 10),
  };

  const serialized = serializeNote(frontmatter, body);
  const validated = parseNote(serialized, {
    filePath: toPosixPath(relPosix),
    strictLf: true,
    expectedType: 'handoff',
  });

  if (validated.errors.length > 0) {
    const first = validated.errors[0];
    const budget = /token budget|exceeds \d+-token|exceeds 5 bullets/i.test(first);
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      budget ? ERROR_CODES.BUDGET_EXCEEDED : ERROR_CODES.INVALID_FRONTMATTER,
      first,
    );
  }

  atomicWriteUtf8(target.absPath, serialized);

  const tokens = estimateTokens(serialized);
  emitTokenNotice(ctx, tokens);

  /** @type {Record<string, unknown>} */
  const payload = {
    id: frontmatter.id,
    path: target.relPosix,
    run,
    slice,
    status,
    tokens,
  };
  emitSuccess(ctx, payload, `wrote ${target.relPosix} (${tokens} est. tokens, ${bulletCount(body)} bullets)`);
  return EXIT_CODES.OK;
}

/**
 * List handoff notes for a single run id.
 * @param { { root: string, flags: Record<string, string | boolean>, positionals: string[], json: boolean, quiet: boolean } } ctx
 * @returns {Promise<number>}
 */
export async function listHandoffs(ctx) {
  const runsRelDir = resolveRunsRelDir(ctx.layout, ctx.flags);
  const runRaw = ctx.flags.run;
  const run = runRaw === undefined ? '' : String(runRaw);
  if (!RUN_PATTERN.test(run)) {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.INVALID_FRONTMATTER,
      'invalid or missing --run for handoff list',
    );
  }

  const runDir = resolveSafePath(ctx.root, `${runsRelDir}/${run}`);
  if (!runDir.relPosix.startsWith(`${runsRelDir}/`) || run.includes('..') || run.length > 40) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, `handoff list path escapes ${runsRelDir}: ${run}`);
  }
  if (!existsSync(runDir.absPath) || !statSync(runDir.absPath).isDirectory()) {
    throw new VaultError(EXIT_CODES.NOT_FOUND, ERROR_CODES.NOT_FOUND, `run not found: ${run}`);
  }

  const entries = readdirSync(runDir.absPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.handoff.md'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const handoffs = entries.map((entry) => {
    const filePath = join(runDir.absPath, entry.name);
    const relPosix = `${runsRelDir}/${run}/${entry.name}`;
    const raw = readBoundedUtf8(filePath, { rootReal: ctx.root });
    const parsed = parseNote(raw, { filePath: relPosix, strictLf: true, expectedType: 'handoff' });
    const fm = parsed.frontmatter;
    return {
      id: typeof fm.id === 'string' && fm.id ? fm.id : buildHandoffId(run, String(fm.slice ?? 'unknown')),
      slice: typeof fm.slice === 'string' ? fm.slice : '',
      status: typeof fm.status === 'string' ? fm.status : '',
      owner: typeof fm.owner === 'string' ? fm.owner : '',
      files_changed: Array.isArray(fm.files_changed) ? fm.files_changed : [],
      tests_run: Array.isArray(fm.tests_run) ? fm.tests_run : [],
      decisions: Array.isArray(fm.decisions) ? fm.decisions : [],
      blockers: Array.isArray(fm.blockers) ? fm.blockers : [],
      updated: typeof fm.updated === 'string' ? fm.updated : '',
      path: relPosix,
      tokens: estimateTokens(raw),
    };
  });

  const payload = { run, count: handoffs.length, handoffs };
  const human =
    handoffs.length === 0
      ? `run ${run}: no handoffs`
      : handoffs.map((h) => `${h.slice}\t${h.status}\t${h.owner}\t${h.path}`).join('\n');
  emitSuccess(ctx, payload, human);
  return EXIT_CODES.OK;
}
