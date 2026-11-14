import { existsSync } from 'node:fs';
import {
  ERROR_CODES,
  EXIT_CODES,
  VaultError,
  computeIndexSourceHash,
  matchesGlob,
  readBoundedBuffer,
  readBoundedUtf8,
  resolveSafePath,
  sha256Hex,
  toPosixPath,
} from './shared.mjs';

/**
 * True when a path lives under one of the configured source roots. A file that
 * lives here but is absent from a fresh index means the index is stale.
 * @param {string} relPosix
 * @param {string[]} [srcRoots]
 */
export function isScannedPath(relPosix, srcRoots = []) {
  const posix = toPosixPath(relPosix);
  return srcRoots.some((root) => posix.startsWith(`${toPosixPath(root)}/`));
}

/**
 * @param {string} message
 * @returns {never}
 */
function staleError(message) {
  throw new VaultError(EXIT_CODES.STALE_INDEX, ERROR_CODES.STALE_INDEX, message);
}

/**
 * Load `.opencode/vault/.index/context-index.json` under `ctx.root` and verify it
 * still matches the filesystem. Missing or stale indexes are exit 4.
 *
 * @param { { root: string } } ctx
 * @returns { { schema_version: number, generated_at: string, root: string, source_hash: string,
 *   stats: Record<string, number>, notes: any[], files: any[], symbols: Record<string, any[]> } }
 */
export function loadFreshIndex(ctx) {
  const { absPath } = resolveSafePath(ctx.root, ctx.layout.indexRelPath);

  if (!existsSync(absPath)) {
    staleError('context index missing; run vault index');
  }

  let raw;
  try {
    raw = readBoundedUtf8(absPath, { rootReal: ctx.root });
  } catch (err) {
    if (err instanceof VaultError && err.exitCode === EXIT_CODES.NOT_FOUND) {
      staleError('context index missing; run vault index');
    }
    throw err;
  }

  let index;
  try {
    index = JSON.parse(raw);
  } catch {
    staleError('context index is stale; run vault index');
  }

  if (
    index === null ||
    typeof index !== 'object' ||
    !Array.isArray(index.files) ||
    !Array.isArray(index.notes) ||
    index.symbols === null ||
    typeof index.symbols !== 'object'
  ) {
    staleError('context index is stale; run vault index');
  }

  try {
    if (computeIndexSourceHash(index.files) !== index.source_hash) {
      staleError('context index is stale; run vault index');
    }

    for (const entry of index.files) {
      if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') {
        staleError('context index is stale; run vault index');
      }
      const { absPath: fileAbs } = resolveSafePath(ctx.root, entry.path);
      if (!existsSync(fileAbs)) {
        staleError('context index is stale; run vault index');
      }
      if (sha256Hex(readBoundedBuffer(fileAbs, { rootReal: ctx.root })) !== entry.hash) {
        staleError('context index is stale; run vault index');
      }
    }

    for (const entry of index.notes) {
      if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') {
        staleError('context index is stale; run vault index');
      }
      const { absPath: noteAbs } = resolveSafePath(ctx.root, entry.path);
      if (!existsSync(noteAbs)) {
        staleError('context index is stale; run vault index');
      }
      if (readBoundedBuffer(noteAbs, { rootReal: ctx.root }).byteLength !== entry.bytes) {
        staleError('context index is stale; run vault index');
      }
    }
  } catch (err) {
    if (err instanceof VaultError) {
      throw err;
    }
    staleError('context index is stale; run vault index');
  }

  return index;
}

/**
 * @param { { notes: any[] } } index
 * @param {string} id
 */
export function noteById(index, id) {
  return index.notes.find((note) => note.id === id) ?? null;
}

/**
 * Resolve `--task` to a note: exact id first, then a file's owning slice, then a
 * slice whose `paths` glob matches, then an exact note path.
 *
 * @param { { notes: any[], files: any[] } } index
 * @param {string} task
 */
export function resolveTaskNote(index, task) {
  const raw = String(task ?? '').trim();
  if (raw === '') return null;

  const exact = index.notes.find((note) => note.id === raw);
  if (exact) return exact;

  const posix = toPosixPath(raw);
  const fileEntry = index.files.find((file) => toPosixPath(file.path) === posix);
  if (fileEntry) {
    if (typeof fileEntry.owner_slice === 'string') {
      const owner = noteById(index, fileEntry.owner_slice);
      if (owner) return owner;
    }
    if (Array.isArray(fileEntry.notes)) {
      for (const noteId of fileEntry.notes) {
        const linked = noteById(index, noteId);
        if (linked) return linked;
      }
    }
  }

  const pathMatches = index.notes
    .filter(
      (note) =>
        note.type === 'slice' &&
        Array.isArray(note.paths) &&
        note.paths.some((pattern) => matchesGlob(posix, pattern) || toPosixPath(pattern) === posix),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (pathMatches.length > 0) return pathMatches[0];

  return index.notes.find((note) => toPosixPath(note.path) === posix) ?? null;
}

/**
 * @param {string} query
 * @returns {string[]}
 */
export function tokenizeQuery(query) {
  return [
    ...new Set(
      String(query ?? '')
        .toLowerCase()
        .split(/[^a-z0-9_-]+/)
        .filter((token) => token.length > 0),
    ),
  ];
}

/**
 * @param {unknown[]} values
 * @param {string} qLower
 * @param {string[]} tokens
 */
function pathSymbolWeight(values, qLower, tokens) {
  let best = 0;
  for (const value of values) {
    const text = String(value ?? '').toLowerCase();
    if (text === '') continue;
    if (text === qLower) {
      best = Math.max(best, 500);
      continue;
    }
    if (text.includes(qLower)) {
      best = Math.max(best, 300);
      continue;
    }
    for (const token of tokens) {
      if (token.length > 1 && text.includes(token)) {
        best = Math.max(best, 300);
        break;
      }
    }
  }
  return best;
}

/**
 * Deterministic score for one note. Weights are fixed by the CLI contract:
 * exact id (1000) > symbol/path/contract (500 exact, 300 token) > tag (200) >
 * title token (100 each) > summary/id token (40 each).
 *
 * @param { { files: any[] } } index
 * @param {any} note
 * @param {string} qLower
 * @param {string[]} tokens
 */
export function scoreNote(index, note, qLower, tokens) {
  let score = 0;

  const idLower = String(note.id ?? '').toLowerCase();
  if (idLower === qLower) score += 1000;

  const associatedFiles = index.files.filter(
    (file) =>
      (Array.isArray(file.notes) && file.notes.includes(note.id)) || file.owner_slice === note.id,
  );

  const pointerValues = [
    ...(Array.isArray(note.symbols) ? note.symbols : []),
    ...(Array.isArray(note.paths) ? note.paths : []),
    ...(Array.isArray(note.contracts) ? note.contracts : []),
    ...(Array.isArray(note.paths) ? [note.path] : []),
  ];
  for (const file of associatedFiles) {
    pointerValues.push(file.path);
    if (Array.isArray(file.exports)) {
      for (const exp of file.exports) pointerValues.push(exp?.name);
    }
    if (Array.isArray(file.contract_refs)) pointerValues.push(...file.contract_refs);
  }
  score += pathSymbolWeight(pointerValues, qLower, tokens);

  const tags = Array.isArray(note.tags) ? note.tags : [];
  const tagHit = tags.some((tag) => {
    const text = String(tag ?? '').toLowerCase();
    if (text === '') return false;
    if (text === qLower || text.includes(qLower)) return true;
    return tokens.some((token) => token.length > 1 && text.includes(token));
  });
  if (tagHit) score += 200;

  const titleLower = String(note.title ?? '').toLowerCase();
  const summaryLower = String(note.summary ?? '').toLowerCase();
  for (const token of tokens) {
    if (titleLower.includes(token)) score += 100;
    if (summaryLower.includes(token) || idLower.includes(token)) score += 40;
  }

  return score;
}

/**
 * Rank every note with a positive score; ties break on id ascending.
 *
 * @param { { notes: any[], files: any[] } } index
 * @param {string} query
 * @returns {Array<{ note: any, score: number }>}
 */
export function rankNoteEntries(index, query) {
  const qLower = String(query ?? '').trim().toLowerCase();
  const tokens = tokenizeQuery(qLower);
  if (qLower === '') return [];

  const entries = [];
  for (const note of index.notes) {
    const score = scoreNote(index, note, qLower, tokens);
    if (score > 0) entries.push({ note, score });
  }

  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.note.id < b.note.id) return -1;
    if (a.note.id > b.note.id) return 1;
    return 0;
  });
  return entries;
}

/**
 * Exact row shape returned by `find`.
 *
 * @param {any} note
 * @param {number} score
 */
export function toFindRow(note, score) {
  return {
    id: note.id,
    title: note.title,
    path: note.path,
    type: note.type,
    score,
    summary: typeof note.summary === 'string' ? note.summary : '',
  };
}

/**
 * @param {any} note
 * @param {string} globPattern
 */
export function notePathMatches(note, globPattern) {
  if (matchesGlob(note.path, globPattern)) return true;
  return Array.isArray(note.paths)
    ? note.paths.some(
        (pattern) => matchesGlob(pattern, globPattern) || toPosixPath(pattern) === toPosixPath(globPattern),
      )
    : false;
}
