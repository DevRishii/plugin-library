/**
 * Deterministic lexical source scanner.
 *
 * `typescript@7.x` in this repo is the native `tsgo` compiler and does not
 * expose the TypeScript 5.x `ts.createSourceFile` API, so this module performs
 * its own character-by-character scan. It has zero runtime dependencies and
 * never touches the filesystem or the network.
 *
 * Public surface:
 *   scanSourceFile(content, lang) -> { exports: ExportEntry[], imports: string[] }
 */

const CODE_LANGS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

const REGEX_PREFIX_CHARS = '([{,;:=!&|?+-*%^~<>';

const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const DECLARATION_STARTERS = [
  'export',
  'import',
  'const',
  'let',
  'var',
  'function',
  'class',
  'interface',
  'type',
  'enum',
];

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isSpaceChar(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v';
}

/**
 * @param {string} text
 * @param {number} index
 * @param {string} word
 * @returns {boolean}
 */
function wordAt(text, index, word) {
  if (index < 0 || index + word.length > text.length) return false;
  if (text.slice(index, index + word.length) !== word) return false;
  const before = index > 0 ? text[index - 1] : '';
  const after = index + word.length < text.length ? text[index + word.length] : '';
  if (before && IDENT_PART.test(before)) return false;
  if (after && IDENT_PART.test(after)) return false;
  return true;
}

/**
 * Skip an evenly-quoted string starting at `start` (the opening quote).
 * Returns the index just past the closing quote (or the line break on an
 * unterminated literal).
 * @param {string} text
 * @param {number} start
 */
function skipQuoted(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === '\n') return i;
    i += 1;
  }
  return text.length;
}

/**
 * Skip a template literal starting at `start` (the opening backtick),
 * correctly walking nested `${ ... }` expressions.
 * @param {string} text
 * @param {number} start
 */
function skipTemplate(text, start) {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i + 1;
    if (ch === '$' && text[i + 1] === '{') {
      i = skipTemplateExpression(text, i + 2);
      continue;
    }
    i += 1;
  }
  return text.length;
}

/**
 * Skip the code inside a `${ ... }` template expression. Returns the index
 * just past the matching `}`.
 * @param {string} text
 * @param {number} start
 */
function skipTemplateExpression(text, start) {
  let i = start;
  let depth = 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(text.length, i + 2);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(text, i);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(text, i);
      continue;
    }
    if (ch === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return text.length;
}

/**
 * Heuristic regex-literal detection based on the previous significant token.
 * @param {string} lastSig
 * @param {string} lastWord
 */
function isRegexStart(lastSig, lastWord) {
  if (lastSig === '') return true;
  if (REGEX_PREFIX_CHARS.includes(lastSig)) return true;
  if (lastWord && REGEX_KEYWORDS.has(lastWord)) return true;
  return false;
}

/**
 * Skip a regex literal starting at `start` (the opening slash).
 * @param {string} text
 * @param {number} start
 */
function skipRegex(text, start) {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n') return i;
    if (inClass) {
      if (ch === ']') inClass = false;
      i += 1;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === '/') {
      i += 1;
      while (i < text.length && /[a-z]/i.test(text[i])) i += 1;
      return i;
    }
    i += 1;
  }
  return text.length;
}

/**
 * Blank every comment, string, template literal and regex literal while
 * preserving indices and line breaks, so the declaration scanner only ever
 * sees executable code. String literal values are recorded separately.
 *
 * @param {string} text
 * @returns { { masked: string, strings: Map<number, { value: string, end: number }> } }
 */
function maskContent(text) {
  const n = text.length;
  const chars = text.split('');
  /** @type {Map<number, { value: string, end: number }>} */
  const strings = new Map();

  /** @param {number} from @param {number} to */
  const blank = (from, to) => {
    const stop = Math.min(to, n);
    for (let k = from; k < stop; k += 1) {
      if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ';
    }
  };

  let i = 0;
  let lastWord = '';
  let lastSig = '';

  while (i < n) {
    const ch = text[i];

    if (ch === '/' && text[i + 1] === '/') {
      let end = i + 2;
      while (end < n && text[end] !== '\n') end += 1;
      blank(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      let end = i + 2;
      while (end < n && !(text[end] === '*' && text[end + 1] === '/')) end += 1;
      end = Math.min(n, end + 2);
      blank(i, end);
      i = end;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const end = skipQuoted(text, i);
      const closed = end <= n && end > i + 1 && text[end - 1] === ch;
      const valueEnd = closed ? end - 1 : end;
      strings.set(i, { value: text.slice(i + 1, valueEnd), end });
      blank(i, end);
      i = end;
      lastSig = ch;
      lastWord = '';
      continue;
    }

    if (ch === '`') {
      const end = skipTemplate(text, i);
      blank(i, end);
      i = end;
      lastSig = '`';
      lastWord = '';
      continue;
    }

    if (ch === '/' && isRegexStart(lastSig, lastWord)) {
      const end = skipRegex(text, i);
      blank(i, end);
      i = end;
      lastSig = ')';
      lastWord = '';
      continue;
    }

    if (IDENT_PART.test(ch)) {
      let end = i + 1;
      while (end < n && IDENT_PART.test(text[end])) end += 1;
      lastWord = text.slice(i, end);
      lastSig = text[end - 1];
      i = end;
      continue;
    }

    if (!isSpaceChar(ch)) {
      lastSig = ch;
      lastWord = '';
    }
    i += 1;
  }

  return { masked: chars.join(''), strings };
}

/**
 * @param {string} masked
 * @param {number} from
 * @param {Map<number, { value: string, end: number }>} strings
 */
function skipWhitespace(masked, from, strings) {
  let i = from;
  while (i < masked.length && isSpaceChar(masked[i]) && !strings.has(i)) i += 1;
  return i;
}

/**
 * Find the matching closing brace for `open` in masked text.
 * @param {string} masked
 * @param {number} open
 */
function matchBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * @param {string} masked
 * @param {number} from
 */
function nextNonSpace(masked, from) {
  let i = from;
  while (i < masked.length && isSpaceChar(masked[i])) i += 1;
  return i;
}

/**
 * Locate the first block body from `from`, tolerating a leading type literal
 * (for example `function f(): { a: string } { ... }`).
 * @param {string} masked
 * @param {number} from
 */
function findBodyBlock(masked, from) {
  for (let i = from; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === ';') return null;
    if (ch === '}') return null;
    if (ch === '{') {
      const close = matchBrace(masked, i);
      if (close === -1) return { close: masked.length - 1 };
      const after = nextNonSpace(masked, close + 1);
      if (after < masked.length && masked[after] === '{') {
        i = after - 1;
        continue;
      }
      return { close };
    }
  }
  return null;
}

/**
 * @param {string} masked
 * @param {number} index
 */
function isDeclarationStart(masked, index) {
  for (const word of DECLARATION_STARTERS) {
    if (wordAt(masked, index, word)) return true;
  }
  return false;
}

/**
 * Find the end of a statement (`;` at depth zero), a declaration boundary on a
 * later line, or the enclosing block close. Returns the index of the last
 * significant character that belongs to the statement.
 * @param {string} masked
 * @param {number} from
 */
function findStatementEnd(masked, from) {
  let depth = 0;
  let lastSig = from - 1;
  let atLineStart = false;

  for (let i = from; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '\n') {
      atLineStart = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') continue;
    if (atLineStart && depth === 0 && i !== from && isDeclarationStart(masked, i)) {
      return { index: lastSig };
    }
    atLineStart = false;

    if (ch === ';' && depth === 0) {
      return { index: i };
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      depth += 1;
      lastSig = i;
      continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      if (depth === 0) {
        return { index: lastSig };
      }
      depth -= 1;
      lastSig = i;
      continue;
    }
    lastSig = i;
  }

  return { index: Math.max(lastSig, from - 1) };
}

/**
 * @param {string} masked
 * @param {number} i
 * @param {(index: number) => number} lineOf
 */
function parseExportAt(masked, i, lineOf) {
  let j = skipWhitespace(masked, i + 6, new Map());

  if (wordAt(masked, j, 'default')) return null;
  if (wordAt(masked, j, 'async')) j = skipWhitespace(masked, j + 5, new Map());
  if (wordAt(masked, j, 'abstract')) j = skipWhitespace(masked, j + 8, new Map());
  if (wordAt(masked, j, 'declare')) j = skipWhitespace(masked, j + 7, new Map());

  /** @type {string | null} */
  let kind = null;

  if (wordAt(masked, j, 'function')) {
    kind = 'function';
    j = skipWhitespace(masked, j + 8, new Map());
    if (masked[j] === '*') j = skipWhitespace(masked, j + 1, new Map());
  } else if (wordAt(masked, j, 'class')) {
    kind = 'class';
    j = skipWhitespace(masked, j + 5, new Map());
  } else if (wordAt(masked, j, 'interface')) {
    kind = 'interface';
    j = skipWhitespace(masked, j + 9, new Map());
  } else if (wordAt(masked, j, 'type')) {
    const after = skipWhitespace(masked, j + 4, new Map());
    if (masked[after] === '{' || masked[after] === '*' || after >= masked.length) return null;
    kind = 'type';
    j = after;
  } else if (wordAt(masked, j, 'enum')) {
    kind = 'enum';
    j = skipWhitespace(masked, j + 4, new Map());
  } else if (wordAt(masked, j, 'const')) {
    const after = skipWhitespace(masked, j + 5, new Map());
    if (wordAt(masked, after, 'enum')) {
      kind = 'enum';
      j = skipWhitespace(masked, after + 4, new Map());
    } else {
      kind = 'const';
      j = after;
    }
  } else if (wordAt(masked, j, 'let') || wordAt(masked, j, 'var')) {
    kind = 'const';
    j = skipWhitespace(masked, j + 3, new Map());
  } else {
    return null;
  }

  if (!IDENT_START.test(masked[j] ?? '')) return null;
  let nameEnd = j + 1;
  while (nameEnd < masked.length && IDENT_PART.test(masked[nameEnd])) nameEnd += 1;
  const name = masked.slice(j, nameEnd);

  let endIndex;
  if (kind === 'function' || kind === 'class' || kind === 'interface' || kind === 'enum') {
    const body = findBodyBlock(masked, nameEnd);
    if (body) endIndex = body.close;
    else endIndex = findStatementEnd(masked, nameEnd).index;
  } else {
    endIndex = findStatementEnd(masked, nameEnd).index;
  }

  return {
    name,
    kind,
    line: lineOf(i),
    end_line: lineOf(Math.max(endIndex, i)),
    endIndex,
  };
}

/**
 * Extract sorted unique static module specifiers from masked code.
 * @param {string} masked
 * @param {Map<number, { value: string, end: number }>} strings
 */
function extractImports(masked, strings) {
  const n = masked.length;
  const specs = new Set();
  let depth = 0;

  for (let i = 0; i < n; i += 1) {
    const ch = masked[i];
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth !== 0) continue;

    const importKeyword = wordAt(masked, i, 'import');
    const exportKeyword = !importKeyword && wordAt(masked, i, 'export');
    if (!importKeyword && !exportKeyword) continue;

    const j = skipWhitespace(masked, i + 6, strings);

    if (importKeyword) {
      if (!strings.has(j) && masked[j] === '(') continue;
      if (strings.has(j)) {
        const entry = strings.get(j);
        specs.add(entry.value);
        i = entry.end - 1;
        continue;
      }
    }

    let local = 0;
    let k = j;
    while (k < n) {
      if (strings.has(k)) {
        const entry = strings.get(k);
        k = entry.end;
        continue;
      }
      const c = masked[k];
      if (c === '{' || c === '(' || c === '[') {
        local += 1;
      } else if (c === '}' || c === ')' || c === ']') {
        if (local > 0) local -= 1;
      } else if (c === ';' && local === 0) {
        break;
      } else if (c === '\n' && local === 0) {
        const next = skipWhitespace(masked, k + 1, strings);
        if (next >= n) break;
        if (!wordAt(masked, next, 'from')) break;
        k = next;
        continue;
      }

      if (local === 0 && wordAt(masked, k, 'from')) {
        const specIndex = skipWhitespace(masked, k + 4, strings);
        if (strings.has(specIndex)) specs.add(strings.get(specIndex).value);
        break;
      }
      k += 1;
    }
  }

  return [...specs].sort();
}

/**
 * @param {string} text
 */
function buildLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/**
 * @param {number[]} starts
 * @param {number} index
 */
function makeLineOf(starts) {
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

/**
 * Scan a source file for top-level exported declarations and static imports.
 *
 * @param {string} content
 * @param {string} lang
 * @returns { { exports: Array<{ name: string, kind: string, line: number, end_line: number }>, imports: string[] } }
 */
export function scanSourceFile(content, lang) {
  const text = String(content ?? '');
  if (!CODE_LANGS.has(lang)) {
    return { exports: [], imports: [] };
  }

  const { masked, strings } = maskContent(text);
  const lineOf = makeLineOf(buildLineStarts(text));

  /** @type {Array<{ name: string, kind: string, line: number, end_line: number }>} */
  const exports = [];
  let depth = 0;

  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (!wordAt(masked, i, 'export')) continue;

    const parsed = parseExportAt(masked, i, lineOf);
    if (!parsed) continue;

    exports.push({
      name: parsed.name,
      kind: parsed.kind,
      line: parsed.line,
      end_line: parsed.end_line,
    });

    if (parsed.endIndex > i) i = parsed.endIndex;
  }

  return {
    exports,
    imports: extractImports(masked, strings),
  };
}
