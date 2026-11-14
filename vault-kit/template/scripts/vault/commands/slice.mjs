import {
  BUDGETS,
  ERROR_CODES,
  EXIT_CODES,
  VaultError,
  emitSuccess,
  emitTokenNotice,
  estimateTokens,
  readBoundedUtf8,
  resolveSafePath,
  toPosixPath,
} from '../shared.mjs';
import { isScannedPath, loadFreshIndex } from '../rank.mjs';

/**
 * @param {unknown} raw
 * @param {number} fallback
 */
function nonNegativeInt(raw, fallback, flagName) {
  if (raw === undefined) return fallback;
  const text = String(raw).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.INVALID_FRONTMATTER, `invalid ${flagName}: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.INVALID_FRONTMATTER, `invalid ${flagName}: ${text}`);
  }
  return value;
}

/**
 * Split normalized text into lines, dropping the single trailing empty line that
 * a final newline produces.
 *
 * @param {string} content
 */
function splitLines(content) {
  const lines = String(content ?? '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Deterministically find the declaration end line by tracking brace balance,
 * ignoring braces inside strings and comments. Falls back to a `;` terminator
 * when the declaration never opens a block, and to the last line otherwise.
 *
 * @param {string[]} lines
 * @param {number} declStart 1-based
 */
export function computeDeclEnd(lines, declStart) {
  let depth = 0;
  let opened = false;
  let inBlockComment = false;
  let quote = '';

  for (let i = declStart - 1; i < lines.length; i += 1) {
    const line = lines[i];
    let j = 0;
    while (j < line.length) {
      const ch = line[j];
      const next = line[j + 1];

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          j += 2;
          continue;
        }
        j += 1;
        continue;
      }

      if (quote !== '') {
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === quote) quote = '';
        j += 1;
        continue;
      }

      if (ch === '/' && next === '/') break;
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        j += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        j += 1;
        continue;
      }
      if (ch === '{') {
        depth += 1;
        opened = true;
      } else if (ch === '}') {
        depth -= 1;
        if (opened && depth === 0) return i + 1;
      } else if (ch === ';' && !opened) {
        return i + 1;
      }
      j += 1;
    }
  }

  return lines.length;
}

/**
 * @param {any[]} exports
 * @param {Record<string, any[]>} symbols
 * @param {string} symbolName
 * @param {string} relPosix
 */
function findExport(exports, symbols, symbolName, relPosix) {
  const direct = exports.find((exp) => exp?.name === symbolName);
  if (direct) return direct;

  const rows = symbols[symbolName];
  if (!Array.isArray(rows)) return null;
  const hit = rows.find((row) => toPosixPath(row?.path) === relPosix);
  if (!hit || typeof hit.line !== 'number') return null;
  return { name: symbolName, kind: hit.kind, line: hit.line, end_line: hit.end_line };
}

/**
 * @param { { root: string, flags: Record<string, string | boolean>, positionals: string[], json: boolean, quiet: boolean } } ctx
 */
export async function run(ctx) {
  const fileRaw = ctx.flags.file;
  if (typeof fileRaw !== 'string' || fileRaw.trim() === '') {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.INVALID_FRONTMATTER,
      'missing required flag: --file',
    );
  }
  const fileFlag = fileRaw.trim();

  const contextLines = nonNegativeInt(ctx.flags.context, 2, '--context');
  const allowLarge = ctx.flags['allow-large'] === true;

  const symbolRaw = ctx.flags.symbol;
  if (symbolRaw !== undefined && (typeof symbolRaw !== 'string' || symbolRaw.trim() === '')) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.INVALID_FRONTMATTER, 'invalid --symbol');
  }
  const symbolName = typeof symbolRaw === 'string' ? symbolRaw.trim() : null;

  const { absPath, relPosix } = resolveSafePath(ctx.root, fileFlag);
  const content = readBoundedUtf8(absPath, { rootReal: ctx.root });
  const lines = splitLines(content);
  const totalLines = lines.length;

  const index = loadFreshIndex(ctx);
  const fileEntry = index.files.find((file) => toPosixPath(file.path) === relPosix);

  if (!fileEntry) {
    if (isScannedPath(relPosix, ctx.layout.srcRoots)) {
      throw new VaultError(
        EXIT_CODES.STALE_INDEX,
        ERROR_CODES.STALE_INDEX,
        'context index is stale; run vault index',
      );
    }
    throw new VaultError(EXIT_CODES.NOT_FOUND, ERROR_CODES.NOT_FOUND, `file not in index: ${relPosix}`);
  }

  const fileExports = Array.isArray(fileEntry.exports) ? fileEntry.exports : [];
  let start;
  let end;
  let truncated;

  if (symbolName === null) {
    start = 1;
    end = Math.min(totalLines, BUDGETS.SLICE_HEAD_LINES);
    truncated = totalLines > BUDGETS.SLICE_HEAD_LINES;
  } else {
    const exp = findExport(fileExports, index.symbols, symbolName, relPosix);
    if (!exp) {
      throw new VaultError(
        EXIT_CODES.NOT_FOUND,
        ERROR_CODES.NOT_FOUND,
        `symbol not found: ${symbolName} in ${relPosix}`,
      );
    }

    const declStart = exp.line;
    const declEnd =
      typeof exp.end_line === 'number' && exp.end_line >= declStart
        ? Math.min(exp.end_line, totalLines)
        : computeDeclEnd(lines, declStart);

    start = Math.max(1, declStart - contextLines);
    end = Math.min(totalLines, declEnd + contextLines);

    const lineCount = end - start + 1;
    const maxLines = allowLarge ? BUDGETS.SLICE_ALLOW_LARGE_LINES : BUDGETS.SLICE_MAX_LINES;
    if (lineCount > maxLines) {
      throw new VaultError(
        EXIT_CODES.VALIDATION,
        ERROR_CODES.BUDGET_EXCEEDED,
        `slice is ${lineCount} lines, exceeding ${maxLines}-line cap`,
      );
    }
    truncated = false;
  }

  const lineCount = end - start + 1;
  const text = lines.slice(start - 1, end).join('\n');
  const tokens = estimateTokens(text);
  emitTokenNotice(ctx, tokens);

  const payload = {
    file: relPosix,
    symbol: symbolName,
    start,
    end,
    lines: lineCount,
    text,
    exports: fileExports,
    note: fileEntry.owner_slice ?? (fileEntry.notes?.[0] ?? null),
    imports: Array.isArray(fileEntry.imports) ? fileEntry.imports : [],
    contract_refs: Array.isArray(fileEntry.contract_refs) ? fileEntry.contract_refs : [],
    truncated,
  };

  emitSuccess(ctx, payload, `${text}\n`);
  return EXIT_CODES.OK;
}
