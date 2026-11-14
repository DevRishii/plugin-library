import {
  BUDGETS,
  ERROR_CODES,
  EXIT_CODES,
  VaultError,
  emitSuccess,
} from '../shared.mjs';
import {
  loadFreshIndex,
  notePathMatches,
  rankNoteEntries,
  toFindRow,
} from '../rank.mjs';

/**
 * @param {unknown} raw
 * @param {number} fallback
 */
function positiveInt(raw, fallback, flagName) {
  if (raw === undefined) return fallback;
  const text = String(raw).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.INVALID_FRONTMATTER, `invalid ${flagName}: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.INVALID_FRONTMATTER, `invalid ${flagName}: ${text}`);
  }
  return value;
}

/**
 * @param {Array<{ id: string, title: string, score: number }>} rows
 */
function renderHuman(rows) {
  if (rows.length === 0) return 'no matches\n';
  return `${rows.map((row) => `${row.score}\t${row.id}\t${row.title}`).join('\n')}\n`;
}

/**
 * @param { { root: string, flags: Record<string, string | boolean>, positionals: string[], json: boolean, quiet: boolean } } ctx
 */
export async function run(ctx) {
  const queryRaw = ctx.flags.query;
  if (typeof queryRaw !== 'string' || queryRaw.trim() === '') {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.INVALID_FRONTMATTER,
      'missing required flag: --query',
    );
  }
  const query = queryRaw.trim();
  const limit = positiveInt(ctx.flags.limit, BUDGETS.FIND_DEFAULT_LIMIT, '--limit');

  const typeRaw = ctx.flags.type;
  const typeFilter = typeof typeRaw === 'string' ? typeRaw.trim().toLowerCase() : null;

  const pathRaw = ctx.flags.path;
  const pathFilter = typeof pathRaw === 'string' ? pathRaw.trim() : null;

  const index = loadFreshIndex(ctx);
  const entries = rankNoteEntries(index, query);

  const filtered = entries.filter(({ note }) => {
    if (typeFilter !== null && String(note.type ?? '').toLowerCase() !== typeFilter) return false;
    if (pathFilter !== null && !notePathMatches(note, pathFilter)) return false;
    return true;
  });

  const rows = filtered.slice(0, limit).map(({ note, score }) => toFindRow(note, score));

  emitSuccess(ctx, rows, renderHuman(rows));
  return EXIT_CODES.OK;
}
