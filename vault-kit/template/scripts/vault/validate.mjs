import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';

import {
  BUDGETS,
  estimateTokens,
  readBoundedBuffer,
  readBoundedUtf8,
  sha256Hex,
  toPosixPath,
} from './shared.mjs';
import { parseNote } from './frontmatter.mjs';

const SKIP_DIR_NAMES = new Set(['.index', '40-runs', '90-handoffs', '_schema']);
const MAX_HOPS = 2;

/**
 * Recursively list authored `.md` files under `.opencode/vault`.
 * Skips `.index`, `40-runs`, `_schema`, and the vault README.
 * @param {string} rootDir
 * @returns {Array<{ absPath: string, relPosix: string, raw: string }>}
 */
export function scanVaultFiles(rootDir, vaultDirRel = '.opencode/vault') {
  const vaultAbs = resolve(rootDir, vaultDirRel);
  if (!existsSync(vaultAbs)) return [];

  /** @type {Array<{ absPath: string, relPosix: string, raw: string }>} */
  const files = [];

  /** @param {string} absDir @param {string} relDir */
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absPath = resolve(absDir, entry.name);
      const relFromVault = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(absPath, relFromVault);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      if (relFromVault === 'README.md') continue;
      files.push({
        absPath,
        relPosix: toPosixPath(`${vaultDirRel}/${relFromVault}`),
        raw: readBoundedUtf8(absPath, { rootReal: rootDir }),
      });
    }
  };

  walk(vaultAbs, '');
  return files.sort((a, b) => (a.relPosix < b.relPosix ? -1 : a.relPosix > b.relPosix ? 1 : 0));
}

/**
 * Scan and parse authored (non-handoff) vault notes.
 * @param {string} rootDir
 * @param { { strictLf?: boolean } } [options]
 */
export function collectAuthoredNotes(rootDir, options = {}) {
  return scanVaultFiles(rootDir, options.vaultDirRel)
    .map((file) => ({
      ...file,
      parsed: parseNote(file.raw, { filePath: file.relPosix, strictLf: options.strictLf === true }),
    }))
    .filter((note) => note.parsed.frontmatter.type !== 'handoff');
}

/** @param {string} relPosix */
function stemOf(relPosix) {
  const name = basename(relPosix);
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

/**
 * Find a fenced TypeScript/JavaScript block longer than 8 lines.
 * @param {string} body
 * @returns { { lang: string, lines: number } | null}
 */
function findOversizedCodeBlock(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^\s*```\s*(ts|tsx|js|jsx|typescript|javascript)\b/i.exec(lines[i]);
    if (!open) continue;
    let count = 0;
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      if (/^\s*```\s*$/.test(lines[j])) break;
      count += 1;
    }
    if (count > 8) return { lang: open[1].toLowerCase(), lines: count };
    i = j;
  }
  return null;
}

/**
 * Breadth-first reachability from `moc-root` over body wikilinks.
 * @param {Array<{ relPosix: string, parsed: ReturnType<typeof parseNote> }>} authored
 */
function computeReachability(authored) {
  const ids = new Set();
  /** @type {Map<string, string[]>} */
  const adjacency = new Map();

  for (const note of authored) {
    const id = note.parsed.frontmatter.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    ids.add(id);
    adjacency.set(id, note.parsed.links.slice());
  }

  if (!ids.has('moc-root')) {
    return { reachable: authored.length === 0, unreachable: authored.map((note) => note.parsed.frontmatter.id) };
  }

  /** @type {Map<string, number>} */
  const distance = new Map([['moc-root', 0]]);
  const queue = ['moc-root'];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const depth = distance.get(current) ?? 0;
    const next = adjacency.get(current) ?? [];
    for (const target of next) {
      if (!ids.has(target) || distance.has(target)) continue;
      distance.set(target, depth + 1);
      queue.push(target);
    }
  }

  const unreachable = authored
    .map((note) => note.parsed.frontmatter.id)
    .filter((id) => typeof id === 'string' && id !== 'moc-root' && (!distance.has(id) || (distance.get(id) ?? 99) > MAX_HOPS));

  return { reachable: unreachable.length === 0, unreachable };
}

/**
 * Recursively collect runtime handoff files.
 * @param {string} rootDir
 * @returns {Array<{ absPath: string, relPosix: string }>}
 */
function scanRunHandoffs(rootDir, runsRelDir) {
  const runsAbs = resolve(rootDir, runsRelDir);
  if (!existsSync(runsAbs)) return [];
  /** @type {Array<{ absPath: string, relPosix: string }>} */
  const found = [];
  /** @param {string} absDir */
  const walk = (absDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absPath = resolve(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(absPath);
      } else if (entry.isFile() && entry.name.endsWith('.handoff.md')) {
        found.push({ absPath, relPosix: toPosixPath(relative(resolve(rootDir), absPath)) });
      }
    }
  };
  walk(runsAbs);
  return found.sort((a, b) => (a.relPosix < b.relPosix ? -1 : a.relPosix > b.relPosix ? 1 : 0));
}

/**
 * Validate authored vault notes, links, budgets, canonical ids and handoffs.
 *
 * @param {string} rootDir
 * @param { { strict?: boolean } } [options]
 * @returns { {
 *   ok: boolean,
 *   notes: number,
 *   errors: string[],
 *   warnings: string[],
 *   reachable_within_2_hops: boolean,
 * } }
 */
export function validateVault(rootDir, options = {}) {
  const strict = options.strict === true;
  const vaultDirRel = options.vaultDirRel ?? '.opencode/vault';
  const runsRelDir = options.runsRelDir ?? `${vaultDirRel}/90-handoffs`;
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  const parsedFiles = scanVaultFiles(rootDir, vaultDirRel).map((file) => ({
    ...file,
    parsed: parseNote(file.raw, { filePath: file.relPosix, strictLf: strict }),
  }));
  const authored = parsedFiles.filter((note) => note.parsed.frontmatter.type !== 'handoff');

  // 1. Parse-level errors (frontmatter, embeds, BOM/CRLF, id/stem).
  for (const note of parsedFiles) {
    for (const error of note.parsed.errors) {
      errors.push(`${note.relPosix}: ${error}`);
    }
  }

  // 2. Case-insensitive duplicate ids and filename stems.
  /** @type {Map<string, string[]>} */
  const idMap = new Map();
  /** @type {Map<string, string[]>} */
  const stemMap = new Map();
  for (const note of parsedFiles) {
    const id = note.parsed.frontmatter.id;
    if (typeof id === 'string' && id.length > 0) {
      const key = id.toLowerCase();
      idMap.set(key, [...(idMap.get(key) ?? []), note.relPosix]);
    }
    const stemKey = stemOf(note.relPosix).toLowerCase();
    stemMap.set(stemKey, [...(stemMap.get(stemKey) ?? []), note.relPosix]);
  }
  for (const [key, paths] of idMap) {
    if (paths.length > 1) {
      errors.push(`duplicate id (case-insensitive): ${key} in ${paths.join(', ')}`);
    }
  }
  for (const [key, paths] of stemMap) {
    if (paths.length > 1) {
      errors.push(`duplicate filename stem (case-insensitive): ${key} in ${paths.join(', ')}`);
    }
  }

  // 3. Root MOC budget.
  const mocNote =
    parsedFiles.find((note) => note.parsed.frontmatter.id === 'moc-root') ??
    parsedFiles.find((note) => stemOf(note.relPosix) === '00-moc');
  if (mocNote) {
    const tokens = estimateTokens(mocNote.raw);
    if (tokens > BUDGETS.MOC_TOKENS) {
      errors.push(
        `budget_exceeded: ${mocNote.relPosix}: MOC is ${tokens} est. tokens (limit ${BUDGETS.MOC_TOKENS})`,
      );
    }
  }

  const authoredIds = new Set();
  for (const note of authored) {
    const id = note.parsed.frontmatter.id;
    if (typeof id === 'string' && id.length > 0) authoredIds.add(id);
  }

  // 4. Broken wikilinks and frontmatter note references.
  for (const note of parsedFiles) {
    const fm = note.parsed.frontmatter;
    const refs = new Set([
      ...note.parsed.links,
      ...(Array.isArray(fm.depends_on) ? fm.depends_on : []),
      ...(Array.isArray(fm.related) ? fm.related : []),
    ]);
    for (const target of refs) {
      if (!authoredIds.has(target)) {
        errors.push(`broken_link: ${note.relPosix}: link target "${target}" not found`);
      }
    }
  }

  // 5. Pointer existence and source_hash checks.
  for (const note of authored) {
    const fm = note.parsed.frontmatter;
    const paths = Array.isArray(fm.paths) ? fm.paths : [];
    const exactPaths = paths.filter((item) => !/[*?]/.test(item));

    for (const pointer of paths) {
      if (!strict) continue;
      if (/[*?]/.test(pointer)) continue;
      if (fm.type === 'slice' && fm.status === 'planned') continue;
      const abs = resolve(rootDir, pointer);
      if (!existsSync(abs)) {
        errors.push(`invalid_frontmatter: ${note.relPosix}: path does not exist: ${pointer}`);
      }
    }

    const contracts = Array.isArray(fm.contracts) ? fm.contracts : [];
    for (const contractRef of contracts) {
      const filePart = String(contractRef).split('#')[0];
      if (filePart.length === 0) continue;
      const abs = resolve(rootDir, filePart);
      if (!existsSync(abs)) {
        errors.push(`invalid_frontmatter: ${note.relPosix}: contract file does not exist: ${filePart}`);
      }
    }

    if (typeof fm.source_hash === 'string' && exactPaths.length === 1) {
      const abs = resolve(rootDir, exactPaths[0]);
      if (existsSync(abs)) {
        const actual = sha256Hex(readBoundedBuffer(abs, { rootReal: rootDir }));
        if (actual !== fm.source_hash) {
          const message = `source_hash mismatch: ${note.relPosix}: ${exactPaths[0]}`;
          if (strict) {
            errors.push(`invalid_frontmatter: ${message}`);
          } else {
            warnings.push(message);
          }
        }
      }
    }
  }

  // 6. Pointer-only guard: no pasted TypeScript/JavaScript bodies.
  for (const note of authored) {
    const type = note.parsed.frontmatter.type;
    if (type !== 'contract' && type !== 'map' && type !== 'slice') continue;
    const block = findOversizedCodeBlock(note.parsed.body);
    if (!block) continue;
    const message = `${note.relPosix}: ${type} note contains a ${block.lang} code block with ${block.lines} lines (> 8); vault notes carry pointers, not code bodies`;
    warnings.push(`code_body: ${message}`);
    if (strict) errors.push(`invalid_frontmatter: ${message}`);
  }

  // 7. Strict canonical note ids, reachability, and runtime handoffs.
  if (strict) {
    const noteIdsRel = `${vaultDirRel}/_schema/note-ids.json`;
    const noteIdsAbs = resolve(rootDir, noteIdsRel);
    if (existsSync(noteIdsAbs)) {
      let doc;
      try {
        doc = JSON.parse(readBoundedUtf8(noteIdsAbs, { rootReal: rootDir }));
      } catch {
        errors.push(`invalid_frontmatter: ${noteIdsRel}: invalid JSON`);
      }
      if (doc && Array.isArray(doc.notes)) {
        for (const entry of doc.notes) {
          if (!entry || typeof entry !== 'object') continue;
          const entryPath = typeof entry.path === 'string' ? entry.path : '';
          const abs = resolve(rootDir, entryPath);
          if (!existsSync(abs)) {
            errors.push(`invalid_frontmatter: canonical note missing: ${String(entry.id)} (${entryPath})`);
            continue;
          }
          const parsed = parseNote(readBoundedUtf8(abs, { rootReal: rootDir }), {
            filePath: toPosixPath(entryPath),
            strictLf: true,
          });
          if (typeof entry.id === 'string' && parsed.frontmatter.id !== entry.id) {
            errors.push(
              `invalid_frontmatter: canonical id mismatch at ${entryPath}: expected "${entry.id}", got "${String(parsed.frontmatter.id)}"`,
            );
          }
          if (typeof entry.type === 'string' && parsed.frontmatter.type !== entry.type) {
            errors.push(
              `invalid_frontmatter: canonical type mismatch at ${entryPath}: expected "${entry.type}", got "${String(parsed.frontmatter.type)}"`,
            );
          }
        }
      }
    }

    for (const handoff of scanRunHandoffs(rootDir, runsRelDir)) {
      const parsed = parseNote(readBoundedUtf8(handoff.absPath, { rootReal: rootDir }), {
        filePath: handoff.relPosix,
        strictLf: true,
        expectedType: 'handoff',
      });
      for (const error of parsed.errors) {
        errors.push(`${handoff.relPosix}: ${error}`);
      }
    }

    const reachability = computeReachability(authored);
    if (!reachability.reachable) {
      const missing = reachability.unreachable.map((id) => String(id)).join(', ');
      errors.push(`invalid_frontmatter: notes not reachable from moc-root within ${MAX_HOPS} hops: ${missing}`);
    }
  }

  const reachability = computeReachability(authored);

  return {
    ok: errors.length === 0,
    notes: authored.length,
    errors,
    warnings,
    reachable_within_2_hops: reachability.reachable,
  };
}

/**
 * @param {string} rootDir
 */
export function vaultNoteStats(rootDir, options = {}) {
  const notes = collectAuthoredNotes(rootDir, options);
  let totalBytes = 0;
  let totalTokens = 0;
  const rows = notes.map((note) => {
    const bytes = statSync(note.absPath).size;
    const tokens = estimateTokens(note.raw);
    totalBytes += bytes;
    totalTokens += tokens;
    const id = note.parsed.frontmatter.id;
    return {
      id: typeof id === 'string' && id.length > 0 ? id : stemOf(note.relPosix),
      path: note.relPosix,
      bytes,
      estimated_tokens: tokens,
    };
  });
  rows.sort((a, b) => (a.bytes !== b.bytes ? b.bytes - a.bytes : a.path < b.path ? -1 : 1));
  return {
    notesCount: notes.length,
    totalBytes,
    totalTokens,
    largestNotes: rows.slice(0, 10),
  };
}
