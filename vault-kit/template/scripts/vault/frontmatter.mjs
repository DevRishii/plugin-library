import { basename } from 'node:path';
import { BUDGETS, estimateTokens, toPosixPath } from './shared.mjs';

export const NOTE_TYPES = Object.freeze(['moc', 'map', 'contract', 'slice', 'decision', 'runbook', 'handoff']);
export const AUTHORED_NOTE_TYPES = Object.freeze(['moc', 'map', 'contract', 'slice', 'decision', 'runbook']);
export const NOTE_STATUSES = Object.freeze([
  'active',
  'draft',
  'superseded',
  'planned',
  'in_progress',
  'done',
  'blocked',
  'failed',
]);
export const HANDOFF_STATUSES = Object.freeze(['planned', 'in_progress', 'done', 'blocked', 'failed']);
export const NOTE_OWNERS = Object.freeze(['architect', 'builder', 'verifier', 'auditor', 'human', 'librarian']);
export const NOTE_SCOPES = Object.freeze([
  'shared',
  'server',
  'web',
  'client',
  'cli',
  'core',
  'docs',
  'tooling',
  'process',
]);
export const SUMMARY_REQUIRED_TYPES = new Set(['contract', 'slice', 'map', 'decision']);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const SCALAR_KEYS = new Set([
  'id',
  'title',
  'type',
  'status',
  'owner',
  'scope',
  'updated',
  'source_hash',
  'summary',
  'run',
  'slice',
]);

const ARRAY_KEYS = new Set([
  'paths',
  'symbols',
  'contracts',
  'depends_on',
  'related',
  'tags',
  'read_first',
  'acceptance',
  'open_decisions',
  'files_changed',
  'tests_run',
  'decisions',
  'blockers',
]);

const ALL_ALLOWED_KEYS = new Set([...SCALAR_KEYS, ...ARRAY_KEYS]);

const HANDOFF_ALLOWED_KEYS = new Set([
  'id',
  'title',
  'type',
  'status',
  'owner',
  'run',
  'slice',
  'files_changed',
  'tests_run',
  'decisions',
  'blockers',
  'updated',
  'summary',
  'tags',
]);

const HANDOFF_REQUIRED_KEYS = [
  'id',
  'title',
  'type',
  'status',
  'owner',
  'run',
  'slice',
  'files_changed',
  'tests_run',
  'decisions',
  'blockers',
  'updated',
];

const BASE_REQUIRED_KEYS = ['id', 'title', 'type', 'status', 'owner', 'updated'];

const ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RUN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]|\.[A-Za-z0-9_-]){0,39}$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** @param {string} dateStr */
export function isValidIsoDate(dateStr) {
  const m = DATE_PATTERN.exec(dateStr);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
  return day >= 1 && day <= maxDay;
}

/**
 * Normalize a wikilink target (`[[target|alias]]` or `[[target#heading]]`) to a bare note id.
 * Maps `00-MOC` / `00-moc` to `moc-root`.
 * @param {string} rawInner
 */
export function normalizeWikiTarget(rawInner) {
  const withoutAlias = String(rawInner ?? '').split('|')[0];
  const withoutHeading = withoutAlias.split('#')[0].trim();
  if (!withoutHeading) return '';
  if (withoutHeading.toLowerCase() === '00-moc') return 'moc-root';
  return withoutHeading;
}

/**
 * Strip fenced code blocks and inline code spans so wikilink/embed scanning ignores examples.
 * @param {string} markdown
 */
export function stripCodeSegments(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const kept = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!inFence) {
        inFence = true;
        fenceChar = marker[0];
        fenceLen = marker.length;
        kept.push('');
        continue;
      }
      if (marker[0] === fenceChar && marker.length >= fenceLen && /^\s*(?:`{3,}|~{3,})\s*$/.test(line)) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
        kept.push('');
        continue;
      }
    }
    if (inFence) {
      kept.push('');
      continue;
    }
    // Strip inline backtick spans on non-fenced lines
    kept.push(line.replace(/`+[^`]*`+/g, ''));
  }

  return { stripped: kept.join('\n'), hasFencedCodeBlock: kept.length > 0 && hasFence(markdown) };
}

/** @param {string} markdown */
function hasFence(markdown) {
  return /^\s*(?:`{3,}|~{3,})/m.test(String(markdown ?? ''));
}

/**
 * Extract outbound wikilinks and forbidden embeds outside code blocks/spans.
 * @param {string} body
 */
export function extractWikiLinks(body) {
  const { stripped, hasFencedCodeBlock } = stripCodeSegments(body);
  /** @type {string[]} */
  const embeds = [];
  /** @type {string[]} */
  const rawLinks = [];
  const normalizedSet = new Set();

  const pattern = /(!?)\[\[([^\[\]\n]+)\]\]/g;
  let match;
  while ((match = pattern.exec(stripped)) !== null) {
    const isEmbed = match[1] === '!';
    const inner = match[2].trim();
    if (isEmbed) {
      embeds.push(inner);
      continue;
    }
    rawLinks.push(inner);
    const target = normalizeWikiTarget(inner);
    if (target) normalizedSet.add(target);
  }

  return {
    links: [...normalizedSet].sort(),
    rawLinks,
    embeds,
    hasFencedCodeBlock,
  };
}

/**
 * Parse a single YAML scalar token (bare, single-quoted, or double-quoted).
 * Rejects anchors (`&`, `*`), block indicators (`|`, `>`), and nested braces (`{`, `}`).
 * @param {string} raw
 * @param {string[]} errors
 * @param {string} contextLabel
 * @returns {string}
 */
function parseYamlScalar(raw, errors, contextLabel) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';

  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"') || trimmed.length < 2) {
      errors.push(`${contextLabel}: unterminated double-quoted string`);
      return trimmed;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== 'string') {
        errors.push(`${contextLabel}: expected string scalar`);
        return String(parsed);
      }
      return parsed;
    } catch {
      errors.push(`${contextLabel}: invalid escape in double-quoted string`);
      return trimmed.slice(1, -1);
    }
  }

  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      errors.push(`${contextLabel}: unterminated single-quoted string`);
      return trimmed;
    }
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  // Strip trailing inline YAML comment ` # ...`
  const commentIdx = trimmed.search(/\s+#/);
  const clean = commentIdx !== -1 ? trimmed.slice(0, commentIdx).trim() : trimmed;

  if (/^[|>&*]/.test(clean)) {
    errors.push(`${contextLabel}: YAML multiline blocks and anchors are forbidden`);
    return clean;
  }
  if (clean.startsWith('{') || clean.endsWith('}')) {
    errors.push(`${contextLabel}: nested YAML maps are forbidden`);
    return clean;
  }
  return clean;
}

/**
 * Parse an inline YAML array `[a, "b", 'c']`.
 * @param {string} raw
 * @param {string[]} errors
 * @param {string} key
 * @returns {string[]}
 */
function parseInlineArray(raw, errors, key) {
  const commentFree = stripTrailingUnquotedComment(raw).trim();
  if (!commentFree.startsWith('[') || !commentFree.endsWith(']')) {
    errors.push(`key "${key}": malformed inline array`);
    return [];
  }
  const inner = commentFree.slice(1, -1).trim();
  if (inner === '') return [];

  /** @type {string[]} */
  const items = [];
  let current = '';
  let quote = '';
  let escaped = false;

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) {
        if (quote === "'" && inner[i + 1] === "'") {
          current += "'";
          i += 1;
          continue;
        }
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') {
      errors.push(`key "${key}": nested collections in inline array are forbidden`);
      return items;
    }
    if (ch === ',') {
      items.push(parseYamlScalar(current, errors, `key "${key}" item`));
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote) {
    errors.push(`key "${key}": unterminated quote in inline array`);
  }
  if (current.trim().length > 0 || inner.endsWith(',')) {
    if (inner.endsWith(',') && current.trim().length === 0) {
      errors.push(`key "${key}": trailing comma in inline array`);
    } else {
      items.push(parseYamlScalar(current, errors, `key "${key}" item`));
    }
  }
  return items;
}

/** @param {string} raw */
function stripTrailingUnquotedComment(raw) {
  let quote = '';
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && i > 0 && /\s/.test(raw[i - 1])) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw;
}

/**
 * Parse and validate a Vault Markdown note (frontmatter + body + wikilinks).
 *
 * @param {string} rawContent
 * @param { { filePath?: string, strictLf?: boolean, expectedType?: string } } [options]
 */
export function parseNote(rawContent, options = {}) {
  /** @type {string[]} */
  const errors = [];
  const text = String(rawContent ?? '');
  const hasBom = text.startsWith('\uFEFF');
  if (hasBom) {
    errors.push('UTF-8 BOM is not allowed');
  }
  const hasCrlf = text.includes('\r\n');
  if (options.strictLf && hasCrlf) {
    errors.push('CRLF line endings are not allowed in strict mode');
  }

  const cleanText = hasBom ? text.slice(1) : text;
  const lines = cleanText.split(/\r?\n/);

  /** @type {Record<string, any>} */
  const frontmatter = Object.create(null);

  if (lines[0]?.trim() !== '---') {
    errors.push('missing opening --- YAML frontmatter delimiter on line 1');
    return {
      frontmatter,
      body: cleanText,
      links: [],
      embeds: [],
      hasBom,
      hasCrlf,
      errors,
    };
  }

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    errors.push('missing closing --- YAML frontmatter delimiter');
    return {
      frontmatter,
      body: '',
      links: [],
      embeds: [],
      hasBom,
      hasCrlf,
      errors,
    };
  }

  const fmLines = lines.slice(1, closeIdx);
  const body = lines.slice(closeIdx + 1).join('\n');

  /** @type {string | null} */
  let currentListKey = null;

  for (let i = 0; i < fmLines.length; i += 1) {
    const lineNo = i + 2;
    const rawLine = fmLines[i];
    if (rawLine.includes('\t')) {
      errors.push(`line ${lineNo}: tab indentation is not allowed in frontmatter`);
      continue;
    }
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const listMatch = /^(\s*)-\s*(.*)$/.exec(rawLine);
    if (listMatch) {
      if (!currentListKey) {
        errors.push(`line ${lineNo}: unexpected list item without an active list key`);
        continue;
      }
      const itemRaw = listMatch[2];
      if (/^[a-zA-Z0-9_-]+\s*:/.test(itemRaw) && !itemRaw.startsWith('"') && !itemRaw.startsWith("'")) {
        // Check if this is `path#symbol` or a URL/command vs nested map:
        // Only treat unquoted `key: value` inside a list item as a nested map!
        const colonIdx = itemRaw.indexOf(':');
        const afterColon = itemRaw.slice(colonIdx + 1);
        if (afterColon === '' || afterColon.startsWith(' ')) {
          errors.push(`line ${lineNo}: nested objects inside list "${currentListKey}" are forbidden`);
          continue;
        }
      }
      const val = parseYamlScalar(itemRaw, errors, `line ${lineNo} (${currentListKey})`);
      frontmatter[currentListKey].push(val);
      continue;
    }

    if (/^\s+/.test(rawLine)) {
      errors.push(`line ${lineNo}: nested maps or multiline scalars are forbidden`);
      continue;
    }

    currentListKey = null;
    const kvMatch = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(rawLine);
    if (!kvMatch) {
      errors.push(`line ${lineNo}: malformed frontmatter entry`);
      continue;
    }

    const key = kvMatch[1];
    const rest = kvMatch[2];

    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`line ${lineNo}: forbidden key "${key}"`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      errors.push(`line ${lineNo}: duplicate frontmatter key "${key}"`);
      continue;
    }

    const restNoComment = stripTrailingUnquotedComment(rest).trim();
    if (restNoComment === '') {
      if (ARRAY_KEYS.has(key)) {
        frontmatter[key] = [];
        currentListKey = key;
      } else {
        frontmatter[key] = '';
      }
      continue;
    }

    if (restNoComment.startsWith('[')) {
      frontmatter[key] = parseInlineArray(rest, errors, key);
      continue;
    }

    frontmatter[key] = parseYamlScalar(rest, errors, `line ${lineNo} (${key})`);
  }

  validateFrontmatterObject(frontmatter, body, errors, options);

  const wiki = extractWikiLinks(body);
  if (wiki.embeds.length > 0) {
    errors.push(`Obsidian embeds are forbidden (![[${wiki.embeds[0]}]])`);
  }

  if (frontmatter.type === 'handoff' && wiki.hasFencedCodeBlock) {
    errors.push('handoff body must not contain fenced code blocks');
  }

  return {
    frontmatter,
    body,
    links: wiki.links,
    embeds: wiki.embeds,
    hasBom,
    hasCrlf,
    errors,
  };
}

/**
 * Validate parsed frontmatter + type-specific constraints against C1/C3.
 * @param {Record<string, any>} fm
 * @param {string} body
 * @param {string[]} errors
 * @param { { filePath?: string, expectedType?: string } } options
 */
export function validateFrontmatterObject(fm, body, errors, options = {}) {
  const effectiveType = options.expectedType ?? fm.type;
  const isHandoff = effectiveType === 'handoff';
  const allowedSet = isHandoff ? HANDOFF_ALLOWED_KEYS : ALL_ALLOWED_KEYS;
  const requiredKeys = isHandoff ? HANDOFF_REQUIRED_KEYS : BASE_REQUIRED_KEYS;

  for (const key of Object.keys(fm)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`forbidden key "${key}"`);
      continue;
    }
    if (!allowedSet.has(key)) {
      errors.push(`unknown frontmatter key "${key}"`);
      continue;
    }
    if (SCALAR_KEYS.has(key) && typeof fm[key] !== 'string') {
      errors.push(`key "${key}" must be a scalar string`);
    }
    if (ARRAY_KEYS.has(key) && !Array.isArray(fm[key])) {
      errors.push(`key "${key}" must be an array of strings`);
    }
  }

  for (const req of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(fm, req)) {
      errors.push(`missing required frontmatter key "${req}"`);
    } else if (SCALAR_KEYS.has(req) && String(fm[req]).trim() === '') {
      errors.push(`required frontmatter key "${req}" must not be empty`);
    }
  }

  if (typeof fm.id === 'string' && fm.id !== '' && !ID_PATTERN.test(fm.id)) {
    errors.push(`invalid id "${fm.id}" (expected ^[a-z][a-z0-9-]{2,63}$)`);
  }
  if (typeof fm.title === 'string' && (fm.title.length < 1 || fm.title.length > 120)) {
    errors.push('title must be 1..120 characters');
  }
  if (typeof fm.type === 'string' && !NOTE_TYPES.includes(fm.type)) {
    errors.push(`invalid type "${fm.type}"`);
  }
  if (options.expectedType && fm.type && fm.type !== options.expectedType) {
    errors.push(`expected type "${options.expectedType}", got "${fm.type}"`);
  }
  if (typeof fm.status === 'string') {
    const validStatuses = isHandoff ? HANDOFF_STATUSES : NOTE_STATUSES;
    if (!validStatuses.includes(fm.status)) {
      errors.push(`invalid status "${fm.status}"`);
    }
  }
  if (typeof fm.owner === 'string' && !NOTE_OWNERS.includes(fm.owner)) {
    errors.push(`invalid owner "${fm.owner}"`);
  }
  if (fm.scope !== undefined && (typeof fm.scope !== 'string' || !NOTE_SCOPES.includes(fm.scope))) {
    errors.push(`invalid scope "${fm.scope}"`);
  }
  if (typeof fm.updated === 'string' && !isValidIsoDate(fm.updated)) {
    errors.push(`invalid updated date "${fm.updated}" (expected valid YYYY-MM-DD)`);
  }
  if (fm.source_hash !== undefined && (typeof fm.source_hash !== 'string' || !HASH_PATTERN.test(fm.source_hash))) {
    errors.push(`invalid source_hash "${fm.source_hash}" (expected sha256:<64 hex>)`);
  }

  if (typeof fm.type === 'string' && SUMMARY_REQUIRED_TYPES.has(fm.type)) {
    if (typeof fm.summary !== 'string' || fm.summary.trim().length === 0) {
      errors.push(`summary is mandatory for "${fm.type}" notes`);
    }
  }
  if (fm.summary !== undefined && typeof fm.summary === 'string') {
    if (fm.summary.trim().length === 0 || fm.summary.length > 280) {
      errors.push('summary must be 1..280 characters');
    }
  }

  for (const arrKey of ARRAY_KEYS) {
    if (!Array.isArray(fm[arrKey])) continue;
    for (const item of fm[arrKey]) {
      if (typeof item !== 'string' || item.trim() === '') {
        errors.push(`key "${arrKey}" contains an empty or non-string item`);
        break;
      }
    }
  }

  if (Array.isArray(fm.tags)) {
    if (fm.tags.length > 12) {
      errors.push('tags exceeds maximum of 12 items');
    }
    for (const tag of fm.tags) {
      if (!TAG_PATTERN.test(tag)) {
        errors.push(`invalid tag "${tag}" (expected lowercase kebab-case)`);
      }
    }
  }

  for (const refKey of ['depends_on', 'related']) {
    if (!Array.isArray(fm[refKey])) continue;
    for (const ref of fm[refKey]) {
      if (!ID_PATTERN.test(ref)) {
        errors.push(`invalid note id "${ref}" in ${refKey}`);
      }
    }
  }

  if (Array.isArray(fm.read_first) && fm.read_first.length > 5) {
    errors.push('read_first exceeds maximum of 5 items');
  }

  if (isHandoff) {
    if (typeof fm.run === 'string' && !RUN_PATTERN.test(fm.run)) {
      errors.push(`invalid run id "${fm.run}"`);
    }
    if (typeof fm.slice === 'string' && !ID_PATTERN.test(fm.slice)) {
      errors.push(`invalid slice id "${fm.slice}"`);
    }
    const trimmedBody = String(body ?? '').trim();
    const bodyTokens = estimateTokens(trimmedBody);
    if (bodyTokens > BUDGETS.HANDOFF_BODY_TOKENS) {
      errors.push(`handoff body exceeds ${BUDGETS.HANDOFF_BODY_TOKENS}-token budget (${bodyTokens} est. tokens)`);
    }
    const bodyLines = trimmedBody === '' ? [] : trimmedBody.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const bulletLines = bodyLines.filter((l) => /^\s*-\s+/.test(l));
    if (bulletLines.length > BUDGETS.HANDOFF_MAX_BULLETS) {
      errors.push(`handoff body exceeds ${BUDGETS.HANDOFF_MAX_BULLETS} bullets (${bulletLines.length})`);
    }
    const nonBulletLines = bodyLines.filter((l) => !/^\s*-\s+/.test(l));
    if (nonBulletLines.length > 0) {
      errors.push('handoff body may contain bullet lines ("- ...") only');
    }
  }

  if (options.filePath && typeof fm.id === 'string' && fm.id !== '') {
    const posix = toPosixPath(options.filePath);
    const fileName = basename(posix);
    if (isHandoff) {
      if (!fileName.endsWith('.handoff.md')) {
        errors.push(`handoff file "${fileName}" must end with .handoff.md`);
      } else if (typeof fm.slice === 'string' && fileName !== `${fm.slice}.handoff.md`) {
        errors.push(`handoff file "${fileName}" must match "${fm.slice}.handoff.md"`);
      }
    } else if (fileName === '00-MOC.md') {
      if (fm.id !== 'moc-root') {
        errors.push(`00-MOC.md must declare id "moc-root", got "${fm.id}"`);
      }
    } else {
      const stem = fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
      if (stem !== fm.id) {
        errors.push(`note id "${fm.id}" must equal filename stem "${stem}"`);
      }
    }
  }
}

/**
 * Quote a YAML scalar deterministically when needed.
 * @param {string} val
 */
export function formatYamlScalar(val) {
  const s = String(val ?? '');
  if (
    s === '' ||
    /^\s|\s$/.test(s) ||
    /[:#\[\]{}&*!|>'"%@`,?]/.test(s) ||
    /^(?:true|false|null|yes|no|on|off|~|-|\d+(?:\.\d+)?)$/i.test(s)
  ) {
    return JSON.stringify(s);
  }
  return s;
}

/**
 * Deterministically serialize a frontmatter object + Markdown body into a UTF-8 LF note.
 * @param {Record<string, string | string[] | undefined>} fm
 * @param {string} body
 */
export function serializeNote(fm, body = '') {
  const orderedKeys = [
    'id',
    'title',
    'type',
    'status',
    'owner',
    'scope',
    'run',
    'slice',
    'paths',
    'symbols',
    'contracts',
    'depends_on',
    'related',
    'read_first',
    'acceptance',
    'open_decisions',
    'files_changed',
    'tests_run',
    'decisions',
    'blockers',
    'tags',
    'updated',
    'source_hash',
    'summary',
  ];

  const lines = ['---'];
  const emitted = new Set();

  for (const key of orderedKeys) {
    if (!Object.prototype.hasOwnProperty.call(fm, key) || fm[key] === undefined) continue;
    emitted.add(key);
    appendYamlEntry(lines, key, fm[key]);
  }

  for (const key of Object.keys(fm).sort()) {
    if (emitted.has(key) || fm[key] === undefined || FORBIDDEN_KEYS.has(key)) continue;
    appendYamlEntry(lines, key, fm[key]);
  }

  lines.push('---');
  const cleanBody = String(body ?? '').replace(/\r\n/g, '\n').replace(/^\n+/, '');
  if (cleanBody.length === 0) {
    return `${lines.join('\n')}\n`;
  }
  return `${lines.join('\n')}\n\n${cleanBody.endsWith('\n') ? cleanBody : `${cleanBody}\n`}`;
}

/**
 * @param {string[]} lines
 * @param {string} key
 * @param {string | string[]} value
 */
function appendYamlEntry(lines, key, value) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${key}: []`);
      return;
    }
    lines.push(`${key}:`);
    for (const item of value) {
      lines.push(`  - ${formatYamlScalar(item)}`);
    }
    return;
  }
  lines.push(`${key}: ${formatYamlScalar(value)}`);
}

/**
 * Build a deterministic, valid handoff note `id` from `run` and `slice` (`^[a-z][a-z0-9-]{2,63}$`).
 * @param {string} runId
 * @param {string} sliceId
 */
export function buildHandoffId(runId, sliceId) {
  const cleanRun = String(runId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const cleanSlice = String(sliceId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const raw = `handoff-${cleanRun}-${cleanSlice}`.slice(0, 64).replace(/-+$/, '');
  return raw.length >= 3 ? raw : 'handoff-run';
}
