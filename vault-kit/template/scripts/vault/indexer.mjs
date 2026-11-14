/**
 * Context index builder.
 *
 * Scans a bounded set of source trees plus the Vault notes, then writes a
 * deterministic `.opencode/vault/.index/context-index.json`. Fully offline:
 * every byte comes from the local filesystem.
 */

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import { parseNote } from './frontmatter.mjs';
import { scanSourceFile } from './scan.mjs';
import {
  BUDGETS,
  ERROR_CODES,
  EXIT_CODES,
  DEFAULT_SRC_ROOTS,
  VaultError,
  atomicWriteUtf8,
  computeIndexSourceHash,
  globSpecificity,
  isWithinDir,
  matchesGlob,
  readBoundedBuffer,
  readBoundedUtf8,
  resolveSafePath,
  sha256Hex,
  toPosixPath,
} from './shared.mjs';

const SCAN_ROOTS = DEFAULT_SRC_ROOTS;

const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'data',
  'logs',
  '.git',
  '.tmp',
  'coverage',
  '.index',
  '40-runs',
  '90-handoffs',
  '_schema',
]);

const LANG_BY_EXT = Object.freeze({
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'mjs',
  '.cjs': 'cjs',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yml',
  '.toml': 'toml',
  '.md': 'md',
  '.css': 'css',
  '.html': 'html',
  '.sh': 'sh',
  '.ps1': 'ps1',
  '.py': 'py',
  '.go': 'go',
  '.rs': 'rs',
});

/**
 * @param {string} a
 * @param {string} b
 */
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param {string[]} values
 */
function uniqSorted(values) {
  return [...new Set(values)].sort(compareStrings);
}

/**
 * @param {string} relPath
 */
function langForPath(relPath) {
  return LANG_BY_EXT[extname(relPath).toLowerCase()] ?? 'other';
}

/**
 * Line count consistent with the index spec: empty text is zero lines and a
 * single trailing newline does not create an extra line.
 * @param {string} text
 */
function countLoc(text) {
  if (text === '') return 0;
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
}

/**
 * @param {string} rootReal
 * @param {string} absPath
 */
function assertRealPathWithinRoot(rootReal, absPath) {
  const real = realpathSync(absPath);
  if (!isWithinDir(rootReal, real)) {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.REFUSED,
      `symlink escapes root: ${absPath}`,
    );
  }
  return real;
}

/**
 * Deterministic recursive walk that skips the shared directory deny-list and
 * rejects symlinks whose real target escapes `rootReal`.
 *
 * @param {string} rootReal
 * @param {string} absDir
 * @param {string} relDir
 * @param {(absFile: string, relPosix: string) => void} onFile
 * @param {Set<string>} visited
 */
function walkTree(rootReal, absDir, relDir, onFile, visited) {
  const realDir = assertRealPathWithinRoot(rootReal, absDir);
  if (visited.has(realDir)) return;
  visited.add(realDir);

  const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
    compareStrings(a.name, b.name),
  );

  for (const entry of entries) {
    const absEntry = join(absDir, entry.name);
    const relEntry = relDir === '' ? entry.name : `${relDir}/${entry.name}`;

    if (entry.isSymbolicLink()) {
      const targetReal = assertRealPathWithinRoot(rootReal, absEntry);
      const targetStat = statSync(targetReal);
      if (targetStat.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        walkTree(rootReal, targetReal, relEntry, onFile, visited);
      } else if (targetStat.isFile()) {
        onFile(targetReal, relEntry);
      }
      continue;
    }

    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      walkTree(rootReal, absEntry, relEntry, onFile, visited);
      continue;
    }

    if (entry.isFile()) {
      onFile(absEntry, relEntry);
    }
  }
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string');
}

/**
 * Split a `path#symbol` contract reference, normalizing the path half to POSIX.
 * @param {string} entry
 */
function normalizeContractRef(entry) {
  const hashIndex = entry.indexOf('#');
  if (hashIndex === -1) return toPosixPath(entry);
  const pathPart = toPosixPath(entry.slice(0, hashIndex));
  const symbolPart = entry.slice(hashIndex + 1);
  return symbolPart === '' ? pathPart : `${pathPart}#${symbolPart}`;
}

/**
 * @param {string} contractEntry
 */
function contractPath(contractEntry) {
  const normalized = normalizeContractRef(contractEntry);
  const hashIndex = normalized.indexOf('#');
  return hashIndex === -1 ? normalized : normalized.slice(0, hashIndex);
}

/**
 * @param {string} rootReal
 */
function scanSourceFiles(rootReal, srcRoots) {
  /** @type {Array<{
   *   path: string,
   *   lang: string,
   *   bytes: number,
   *   loc: number,
   *   hash: string,
   *   owner_slice: string | null,
   *   exports: Array<{ name: string, kind: string, line: number, end_line: number }>,
   *   imports: string[],
   *   notes: string[],
   *   contract_refs: string[],
   * }>} */
  const files = [];
  const visited = new Set();

  const onFile = (absFile, relPosix) => {
    const lst = lstatSync(absFile);
    if (!lst.isFile()) return;
    const rawBuf = readBoundedBuffer(absFile, { rootReal });
    const text = rawBuf.toString('utf8');
    const path = toPosixPath(relPosix);
    const lang = langForPath(path);
    const scanned = scanSourceFile(text, lang);
    files.push({
      path,
      lang,
      bytes: rawBuf.byteLength,
      loc: countLoc(text),
      hash: sha256Hex(rawBuf),
      owner_slice: null,
      exports: scanned.exports,
      imports: scanned.imports,
      notes: [],
      contract_refs: [],
    });
  };

  for (const tree of srcRoots) {
    const absTree = join(rootReal, tree);
    if (!existsSync(absTree)) continue;
    walkTree(rootReal, absTree, tree, onFile, visited);
  }

  files.sort((a, b) => compareStrings(a.path, b.path));
  return files;
}

/**
 * @param {string} rootReal
 */
function scanVaultNotes(rootReal, vaultDirRel) {
  const vaultAbs = join(rootReal, vaultDirRel);
  if (!existsSync(vaultAbs)) return [];

  /** @type {Array<{ rawText: string, relToRoot: string, bytes: number, parsed: any }>} */
  const parsedNotes = [];
  const visited = new Set();

  walkTree(
    rootReal,
    vaultAbs,
    '',
    (absFile, relFromVault) => {
      if (relFromVault === 'README.md') return;
      if (extname(relFromVault).toLowerCase() !== '.md') return;
      const rawBuf = readBoundedBuffer(absFile, { rootReal });
      const rawText = rawBuf.toString('utf8');
      const relToRoot = toPosixPath(`${vaultDirRel}/${relFromVault}`);
      const parsed = parseNote(rawText, { filePath: relToRoot });
      if (parsed.errors.length > 0) {
        throw new VaultError(
          EXIT_CODES.VALIDATION,
          ERROR_CODES.INVALID_FRONTMATTER,
          `${relToRoot}: ${parsed.errors[0]}`,
        );
      }
      parsedNotes.push({ rawText, relToRoot, bytes: rawBuf.byteLength, parsed });
    },
    visited,
  );

  parsedNotes.sort((a, b) => compareStrings(a.parsed.frontmatter.id ?? '', b.parsed.frontmatter.id ?? ''));

  const seenIds = new Map();
  for (const note of parsedNotes) {
    const id = note.parsed.frontmatter.id;
    const key = String(id).toLowerCase();
    if (seenIds.has(key)) {
      throw new VaultError(
        EXIT_CODES.VALIDATION,
        ERROR_CODES.INVALID_FRONTMATTER,
        `duplicate note id "${id}": ${seenIds.get(key)} and ${note.relToRoot}`,
      );
    }
    seenIds.set(key, note.relToRoot);
  }

  const idSet = new Set(parsedNotes.map((note) => note.parsed.frontmatter.id));
  /** @type {Map<string, string[]>} */
  const inbound = new Map();
  for (const note of parsedNotes) {
    const links = uniqSorted(asStringArray(note.parsed.links));
    for (const link of links) {
      if (!idSet.has(link)) continue;
      if (!inbound.has(link)) inbound.set(link, []);
      inbound.get(link).push(note.parsed.frontmatter.id);
    }
  }

  return parsedNotes.map((note) => {
    const fm = note.parsed.frontmatter;
    const outbound = uniqSorted(asStringArray(note.parsed.links));
    const broken = outbound.filter((link) => !idSet.has(link)).sort(compareStrings);

    /** @type {Record<string, unknown>} */
    const indexed = {
      id: fm.id,
      path: note.relToRoot,
      title: fm.title,
      type: fm.type,
      status: fm.status,
      owner: fm.owner,
      scope: fm.scope ?? null,
      tags: asStringArray(fm.tags),
      paths: asStringArray(fm.paths),
      symbols: asStringArray(fm.symbols),
      contracts: asStringArray(fm.contracts),
      depends_on: asStringArray(fm.depends_on),
      related: asStringArray(fm.related),
      read_first: asStringArray(fm.read_first),
      acceptance: asStringArray(fm.acceptance),
      open_decisions: asStringArray(fm.open_decisions),
      outbound_links: outbound,
      inbound_links: uniqSorted(inbound.get(fm.id) ?? []),
      broken_links: broken,
      summary: typeof fm.summary === 'string' ? fm.summary : '',
      source_hash: typeof fm.source_hash === 'string' ? fm.source_hash : null,
      bytes: note.bytes,
      updated: fm.updated,
    };
    return indexed;
  });
}

/**
 * @param {Array<Record<string, any>>} files
 * @param {Array<Record<string, any>>} notes
 */
function linkFilesToNotes(files, notes) {
  for (const file of files) {
    const matchingIds = new Set();
    const contractRefs = new Set();
    let ownerSlice = null;
    let ownerSpecificity = -1;

    for (const note of notes) {
      const pathMatch = asStringArray(note.paths).some((glob) => matchesGlob(file.path, glob));
      let contractMatch = false;
      for (const contract of asStringArray(note.contracts)) {
        if (contractPath(contract) === file.path) {
          contractMatch = true;
          contractRefs.add(normalizeContractRef(contract));
        }
      }
      if (pathMatch || contractMatch) matchingIds.add(note.id);

      if (note.type === 'slice' && pathMatch) {
        let best = -1;
        for (const glob of asStringArray(note.paths)) {
          if (!matchesGlob(file.path, glob)) continue;
          const specificity = globSpecificity(glob);
          if (specificity > best) best = specificity;
        }
        if (
          best > ownerSpecificity ||
          (best === ownerSpecificity && ownerSlice !== null && compareStrings(note.id, ownerSlice) < 0) ||
          (best > -1 && ownerSlice === null)
        ) {
          ownerSpecificity = best;
          ownerSlice = note.id;
        }
      }
    }

    for (const note of notes) {
      if (!matchingIds.has(note.id)) continue;
      for (const contract of asStringArray(note.contracts)) {
        contractRefs.add(normalizeContractRef(contract));
      }
    }

    file.notes = uniqSorted([...matchingIds]);
    file.contract_refs = uniqSorted([...contractRefs]);
    file.owner_slice = ownerSlice;
  }
}

/**
 * @param {Array<Record<string, any>>} files
 */
function buildSymbols(files) {
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const byName = new Map();
  let total = 0;

  for (const file of files) {
    for (const exported of file.exports) {
      total += 1;
      if (!byName.has(exported.name)) byName.set(exported.name, []);
      /** @type {Record<string, unknown>} */
      const entry = {
        path: file.path,
        line: exported.line,
        kind: exported.kind,
        exported: true,
      };
      if (typeof exported.end_line === 'number') entry.end_line = exported.end_line;
      byName.get(exported.name).push(entry);
    }
  }

  if (total > BUDGETS.MAX_INDEX_SYMBOLS) {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.INDEX_TOO_LARGE,
      `index contains ${total} symbols, exceeding the ${BUDGETS.MAX_INDEX_SYMBOLS}-symbol cap`,
    );
  }

  /** @type {Record<string, Array<Record<string, unknown>>>} */
  const symbols = {};
  for (const key of [...byName.keys()].sort(compareStrings)) {
    const entries = byName.get(key);
    entries.sort((a, b) => {
      const byPath = compareStrings(String(a.path), String(b.path));
      if (byPath !== 0) return byPath;
      return Number(a.line) - Number(b.line);
    });
    symbols[key] = entries;
  }

  return { symbols, total };
}

/**
 * Build the context index object in memory.
 * @param {string} rootDir
 */
export function buildContextIndex(rootDir, layout) {
  const rootReal = realpathSync(rootDir);
  const files = scanSourceFiles(rootReal, layout.srcRoots);
  const notes = scanVaultNotes(rootReal, layout.vaultDirRel);

  linkFilesToNotes(files, notes);
  const { symbols, total } = buildSymbols(files);

  const totalFileBytes = files.reduce((sum, file) => sum + file.bytes, 0);

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    root: '.',
    source_hash: computeIndexSourceHash(files),
    stats: {
      files: files.length,
      notes: notes.length,
      symbols: total,
      bytes: totalFileBytes,
    },
    notes,
    files,
    symbols,
  };
}

/**
 * Build and atomically persist the context index.
 * @param {string} rootDir
 */
export function writeContextIndex(rootDir, layout) {
  const index = buildContextIndex(rootDir, layout);
  const absIndexPath = resolveSafePath(rootDir, layout.indexRelPath).absPath;
  atomicWriteUtf8(absIndexPath, `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

/**
 * Verify that the persisted index matches a fresh in-memory build.
 * @param {string} rootDir
 */
export function checkContextIndex(rootDir, layout) {
  const absIndexPath = resolveSafePath(rootDir, layout.indexRelPath).absPath;
  if (!existsSync(absIndexPath)) {
    throw new VaultError(EXIT_CODES.STALE_INDEX, ERROR_CODES.STALE_INDEX, 'context index is missing');
  }

  let existing;
  try {
    existing = JSON.parse(readBoundedUtf8(absIndexPath, { rootReal: rootDir, maxBytes: 8 * 1024 * 1024 }));
  } catch {
    throw new VaultError(EXIT_CODES.STALE_INDEX, ERROR_CODES.STALE_INDEX, 'context index is stale');
  }

  const current = buildContextIndex(rootDir, layout);

  const existingComparable = JSON.stringify({ ...existing, generated_at: '' });
  const currentComparable = JSON.stringify({ ...current, generated_at: '' });

  if (existingComparable !== currentComparable) {
    throw new VaultError(EXIT_CODES.STALE_INDEX, ERROR_CODES.STALE_INDEX, 'context index is stale');
  }

  return current;
}
