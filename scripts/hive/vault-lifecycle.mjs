#!/usr/bin/env node
/**
 * Obsidian Context Vault lifecycle CLI.
 *
 * Subcommands:
 *   detect            read-only vault state detection (absent | partial | present_*)
 *   plan              pure per-goal prompt plan (prompt_create | prompt_update | none)
 *   scaffold --yes    create missing template files, index, check --strict
 *   update --yes      refresh drifted pointers, index, check --strict
 *   verify            run index + check --strict and report observed exits
 *   state get|record  atomic per-goal prompt bookkeeping in .hive/lifecycle/
 *
 * Zero external dependencies; Node >= 20 ESM. Scaffolding never overwrites
 * existing vault notes, schemas, README files, or application source.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENTS_VAULT_MARKERS,
  DEFAULT_SCRIPTS_DIR,
  ERROR_CODES,
  EXIT_CODES,
  HiveContractError,
  PLAN_ACTIONS,
  SCHEMA_VERSION,
  VAULT_STATES,
  atomicWriteUtf8,
  emitFailure,
  emitSuccess,
  estimateTokens,
  getLibraryRoot,
  isCiEnvironment,
  isWithinDir,
  parseCliArgs,
  readBoundedUtf8,
  resolveRootDir,
  resolveSafePath,
  resolveVaultLayout,
  sha256Hex,
  toPosixPath,
  validateGoalId,
} from './contracts.mjs';
import { detectVault } from './vault-detect.mjs';
import { buildPromptPlan } from './vault-prompt.mjs';
import { parseNote } from '../../vault-kit/template/scripts/vault/frontmatter.mjs';
import { scanSourceFile } from '../../vault-kit/template/scripts/vault/scan.mjs';

const LIFECYCLE_DIR = '.hive/lifecycle';
const OBSERVED_BEGIN = '<!-- context-vault:observed:begin -->';
const OBSERVED_END = '<!-- context-vault:observed:end -->';
const MAX_SCAN_FILES = 80;
const MAX_SCAN_BYTES = 256 * 1024;
const MAX_CONTRACTS = 8;
const MAX_SLICES = 5;
const MAX_EXPORTS_PER_NOTE = 8;
const MAX_MAP_FILES = 12;
const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs']);
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.tmp',
  '.index',
  '90-handoffs',
  '_schema',
  '.hive',
]);
const SRC_ROOT_CANDIDATES = ['src', 'lib', 'app', 'web', 'packages', 'scripts', 'config', 'tests', 'plugins'];

const USAGE = [
  'Usage: node scripts/hive/vault-lifecycle.mjs <command> [options]',
  '',
  'Commands:',
  '  detect                         read-only vault state detection',
  '  plan --goal <id>               pure checkpoint prompt plan for one goal',
  '  scaffold --yes                 create missing vault files, index, check --strict',
  '  update --yes [--goal <id>]     refresh drifted vault pointers, index, check --strict',
  '  verify                         run index + check --strict and report exits',
  '  state get --goal <id>          read the stored lifecycle record (if any)',
  '  state record --goal <id> --choice yes|no [--prompt create|update]',
  '               [--scaffold-exit N] [--index-exit N] [--check-exit N]',
  '',
  'Global options:',
  '  --root <dir>       repository root (default: current directory)',
  '  --vault-dir <dir>  vault directory override (default: vault.config.json or .opencode/vault)',
  '  --json             emit one JSON document on stdout ({ "data": ... })',
  '  --quiet            suppress human-readable output',
  '  --yes              required consent flag for scaffold and update',
  '  --help, -h         show this help',
].join('\n');

/* ------------------------------------------------------------------ *
 * Small validation helpers
 * ------------------------------------------------------------------ */

/** @param {unknown} message @returns {never} */
function refuse(message) {
  throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, message);
}

/** @param {unknown} text @param {number} [max] */
function oneLineValue(text, max = 300) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** @param {unknown} value */
function yamlScalar(value) {
  const text = oneLineValue(value, 500);
  if (text === '') return '""';
  if (/^[A-Za-z0-9][A-Za-z0-9 .,()_/@&+-]*$/.test(text)) return text;
  return JSON.stringify(text);
}

/** @param {unknown} value */
function jsonStringContent(value) {
  return oneLineValue(value, 500).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * @param {string} relPosix
 * @param {string} parent
 */
function relWithin(relPosix, parent) {
  if (parent === '.' || parent === '') return true;
  return relPosix === parent || relPosix.startsWith(`${parent}/`);
}

/** @param {string} relPosix */
function isOwnedTarget(relPosix, layout) {
  if (relPosix === 'AGENTS.md' || relPosix === '.gitignore') return true;
  if (relWithin(relPosix, layout.vaultDirRel)) return true;
  if (
    relPosix === `${layout.scriptsDirRel}/vault.mjs` ||
    relWithin(relPosix, `${layout.scriptsDirRel}/vault`)
  ) {
    return true;
  }
  return (
    relWithin(relPosix, '.opencode/agents') ||
    relWithin(relPosix, '.opencode/commands') ||
    relWithin(relPosix, '.opencode/skills')
  );
}

/** @param {string} absPath @param {string} rootReal */
function readJsonIfPresent(absPath, rootReal) {
  try {
    if (!existsSync(absPath) || !statSync(absPath).isFile()) return null;
    return JSON.parse(readBoundedUtf8(absPath, { rootReal, maxBytes: 512 * 1024 }));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Template rendering
 * ------------------------------------------------------------------ */

/** @returns {string} */
function templateDir() {
  return join(getLibraryRoot(), 'vault-kit', 'template');
}

/**
 * @param {string} rel
 * @param {ReturnType<typeof resolveVaultLayout>} layout
 * @returns {string | null}
 */
function mapTemplateTarget(rel, layout) {
  const posix = toPosixPath(rel);
  if (posix === 'AGENTS.vault-snippet.md') return null;
  if (posix.startsWith('.opencode/vault/')) {
    const tail = posix.slice('.opencode/vault/'.length);
    return toPosixPath(`${layout.vaultDirRel}/${tail}`);
  }
  if (posix.startsWith('scripts/')) {
    const tail = posix.slice('scripts/'.length);
    return toPosixPath(`${layout.scriptsDirRel}/${tail}`);
  }
  return posix;
}

/** @param {string} text @param {Record<string,string>} values @param {'text'|'json'} mode */
function replacePlaceholders(text, values, mode) {
  let out = String(text ?? '');
  for (const [key, value] of Object.entries(values)) {
    const rx = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    const replacement = mode === 'json' ? jsonStringContent(value) : oneLineValue(value, 500);
    out = out.replace(rx, () => replacement);
  }
  return out;
}

/**
 * Replace placeholders safely. YAML scalar frontmatter values are quoted when
 * the substituted value would otherwise change the document structure.
 *
 * @param {string} text
 * @param {Record<string,string>} values
 * @param {string} ext
 * @param {ReturnType<typeof resolveVaultLayout>} layout
 */
function renderTemplateContent(text, values, ext, layout) {
  const source = String(text ?? '').replace(/\r\n/g, '\n');
  const extension = ext.toLowerCase();
  const isMarkdown = extension === '.md';
  const lines = source.split('\n');
  const out = [];
  let inFrontmatter = false;
  let frontmatterDone = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isMarkdown && index === 0 && line === '---') {
      inFrontmatter = true;
      out.push(line);
      continue;
    }
    if (inFrontmatter && line === '---') {
      inFrontmatter = false;
      frontmatterDone = true;
      out.push(line);
      continue;
    }

    let rendered = line;
    if (inFrontmatter && /\{\{/.test(line)) {
      const scalar = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
      if (scalar) {
        const substituted = replacePlaceholders(scalar[2], values, 'text');
        rendered = `${scalar[1]}: ${yamlScalar(substituted)}`;
      } else {
        rendered = replacePlaceholders(line, values, 'text');
      }
    } else {
      rendered = replacePlaceholders(line, values, extension === '.json' ? 'json' : 'text');
    }
    out.push(rendered);
  }

  let result = out.join('\n');
  if (isMarkdown && layout.scriptsDirRel !== DEFAULT_SCRIPTS_DIR) {
    result = result.split('scripts/vault.mjs').join(`${layout.scriptsDirRel}/vault.mjs`);
  }

  const unknown = [...result.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)];
  if (unknown.length > 0) {
    throw new HiveContractError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.TEMPLATE_INVALID,
      `unresolved template placeholder: {{${unknown[0][1]}}}`,
    );
  }
  void frontmatterDone;
  return result;
}

/* ------------------------------------------------------------------ *
 * Project discovery (bounded, read-only, no execution)
 * ------------------------------------------------------------------ */

/** @param {string} rootReal @param {ReturnType<typeof resolveVaultLayout>} layout */
function readPackageJson(rootReal) {
  const parsed = readJsonIfPresent(join(rootReal, 'package.json'), rootReal);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

/** @param {any} pkg */
function dependencyNames(pkg) {
  const deps = [
    ...Object.keys(pkg?.dependencies ?? {}),
    ...Object.keys(pkg?.devDependencies ?? {}),
  ];
  return [...new Set(deps)].sort();
}

/**
 * @param {string} rootReal
 * @param {any} pkg
 * @param {ReturnType<typeof resolveVaultLayout>} layout
 */
function deriveSourceRoots(rootReal, pkg) {
  const configured = readJsonIfPresent(join(rootReal, 'vault.config.json'), rootReal);
  let candidates = SRC_ROOT_CANDIDATES;
  if (Array.isArray(configured?.src_dirs)) {
    const cleaned = configured.src_dirs
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .map((entry) => toPosixPath(entry.trim()))
      .filter((entry) => entry !== '.' && !entry.split('/').includes('..'));
    if (cleaned.length > 0) candidates = cleaned;
  }
  const roots = [];
  for (const rel of candidates) {
    if (roots.length >= 6) break;
    if (roots.includes(rel)) continue;
    try {
      const safe = resolveSafePath(rootReal, rel, 'src_dirs');
      if (existsSync(safe.absPath) && statSync(safe.absPath).isDirectory()) roots.push(safe.relPosix);
    } catch {
      // Ignore an unusable src_dirs entry; the vault CLI applies the same bound.
    }
  }
  void pkg;
  return roots;
}

/** @param {string} rootReal @param {string[]} srcRoots */
function discoverProjectFiles(rootReal, srcRoots) {
  const files = [];
  const seen = new Set();

  /** @param {string} absDir @param {string} relDir @param {number} depth */
  const walk = (absDir, relDir, depth) => {
    if (files.length >= MAX_SCAN_FILES || depth > 6) return;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= MAX_SCAN_FILES) return;
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') {
        if (entry.isDirectory()) continue;
      }
      const abs = join(absDir, entry.name);
      const rel = toPosixPath(relDir === '' ? entry.name : `${relDir}/${entry.name}`);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs, rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!CODE_EXTS.has(ext)) continue;
      if (seen.has(rel)) continue;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.size > MAX_SCAN_BYTES) continue;
      let text;
      try {
        text = readBoundedUtf8(abs, { rootReal, maxBytes: MAX_SCAN_BYTES });
      } catch {
        continue;
      }
      const lang = ext.replace('.', '');
      const scanned = scanSourceFile(text, lang);
      seen.add(rel);
      files.push({
        path: rel,
        abs,
        lines: text === '' ? 0 : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length,
        hash: sha256Hex(text),
        exports: scanned.exports.slice(0, MAX_EXPORTS_PER_NOTE),
      });
    }
  };

  for (const rootRel of srcRoots) {
    const safe = resolveSafePath(rootReal, rootRel, 'src_root');
    walk(safe.absPath, safe.relPosix, 0);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/** @param {string} fmt */
function deriveStack(pkg, rootReal) {
  const parts = [];
  const deps = dependencyNames(pkg);
  if (deps.includes('typescript')) parts.push('typescript');
  parts.push(pkg?.type === 'module' ? 'node esm' : 'javascript');
  const frameworks = [
    'react',
    'vue',
    'svelte',
    'next',
    'vite',
    'express',
    'fastify',
    'jest',
    'vitest',
    'node:test',
  ];
  for (const name of frameworks) {
    if (deps.includes(name) && parts.length < 5) parts.push(name);
  }
  for (const lock of ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']) {
    if (existsSync(join(rootReal, lock)) && parts.length < 6) {
      parts.push(lock.split('.')[0]);
      break;
    }
  }
  return parts.join(', ') || 'node';
}

/** @param {string} rootReal @param {any} pkg */
function deriveTestCommand(rootReal, pkg) {
  if (typeof pkg?.scripts?.test === 'string' && pkg.scripts.test.trim()) {
    return oneLineValue(pkg.scripts.test, 120);
  }
  if (typeof pkg?.scripts?.verify === 'string' && pkg.scripts.verify.trim()) {
    return oneLineValue(pkg.scripts.verify, 120);
  }
  if (existsSync(join(rootReal, 'scripts', 'verify.mjs'))) return 'node scripts/verify.mjs';
  return 'node --test';
}

/**
 * @param {string} rootReal
 * @param {ReturnType<typeof resolveVaultLayout>} layout
 */
function discoverProject(rootReal, layout) {
  const pkg = readPackageJson(rootReal);
  const srcRoots = deriveSourceRoots(rootReal, pkg);
  const files = discoverProjectFiles(rootReal, srcRoots);
  return {
    pkg,
    srcRoots,
    files,
    projectName: oneLineValue(String(pkg?.name ?? '').split('/').pop() || basename(rootReal), 80),
    oneLiner: oneLineValue(
      pkg?.description || `Repository context vault for ${basename(rootReal)}.`,
      180,
    ),
    stack: deriveStack(pkg, rootReal),
    testCmd: deriveTestCommand(rootReal, pkg),
  };
}

/* ------------------------------------------------------------------ *
 * Derived pointer notes
 * ------------------------------------------------------------------ */

/** @param {string} value */
function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 44);
}

/** @param {string} path */
function scopeForPath(path) {
  if (path.startsWith('scripts/')) return 'tooling';
  if (path.startsWith('config/')) return 'shared';
  if (path.startsWith('web/') || path.startsWith('app/')) return 'web';
  return 'core';
}

/** @param {string} date */
function today(date) {
  return date ?? new Date().toISOString().slice(0, 10);
}

/**
 * @param {string} key
 * @param {string[]} items
 */
function yamlList(key, items) {
  return [`${key}:`, ...items.map((item) => `  - ${yamlScalar(item)}`)].join('\n');
}

/** @param {Array<{name:string,line:number,end_line:number}>} exports */
function observedPointerLines(filePath, exports) {
  return exports
    .slice(0, MAX_EXPORTS_PER_NOTE)
    .map((entry) => `- \`${filePath}#${entry.name}\` (L${entry.line}-L${entry.end_line})`);
}

/** @param {string} filePath @param {Array<any>} exports */
function contractObservedBlock(filePath, exports) {
  return [
    OBSERVED_BEGIN,
    '## Observed pointers (derived)',
    '',
    ...(exports.length > 0 ? observedPointerLines(filePath, exports) : ['- No exported symbols observed.']),
    OBSERVED_END,
  ].join('\n');
}

/**
 * @param {ReturnType<typeof discoverProject>} project
 * @param {ReturnType<typeof resolveVaultLayout>} layout
 * @param {string} date
 * @param {Set<string>} excludedPaths
 * @param {number} limit
 */
function deriveContractEntries(project, layout, date, excludedPaths, limit) {
  const entries = [];
  for (const file of project.files) {
    if (entries.length >= limit) break;
    if (file.exports.length === 0) continue;
    if (excludedPaths.has(file.path)) continue;
    if (isOwnedTarget(file.path, layout)) continue;
    const slug = slugify(file.path) || 'module';
    const id = `contract-${slug}`;
    const rel = `${layout.vaultDirRel}/20-contracts/${id}.md`;
    const symbols = file.exports.slice(0, MAX_EXPORTS_PER_NOTE).map((entry) => entry.name);
    const summary = `Exported surface for \`${file.path}\` (${symbols.length} symbol${symbols.length === 1 ? '' : 's'}).`;
    const body = [
      '---',
      `id: ${id}`,
      `title: ${yamlScalar(`Contract: ${file.path}`)}`,
      'type: contract',
      'status: active',
      'owner: architect',
      `scope: ${scopeForPath(file.path)}`,
      `updated: ${today(date)}`,
      `summary: ${yamlScalar(summary)}`,
      yamlList('paths', [file.path]),
      yamlList('symbols', symbols),
      `source_hash: ${file.hash}`,
      '---',
      '',
      `# ${file.path}`,
      '',
      `Pointer-only contract for \`${file.path}\`. Read one range with \`node ${layout.scriptsDirRel}/vault.mjs slice --file ${file.path} --symbol <name>\`.`,
      '',
      contractObservedBlock(file.path, file.exports),
      '',
      'Back to [[map-repo]].',
      '',
    ].join('\n');
    entries.push({ id, rel, path: file.path, content: body, file });
  }
  return entries;
}

/**
 * @param {ReturnType<typeof discoverProject>} project
 * @param {ReturnType<typeof resolveVaultLayout>} layout
 * @param {string} date
 * @param {Set<string>} existingRoots
 * @param {number} limit
 */
function deriveSliceEntries(project, layout, date, existingRoots, limit) {
  const entries = [];
  for (const sourceRoot of project.srcRoots) {
    if (entries.length >= limit) break;
    if (existingRoots.has(sourceRoot)) continue;
    const slug = slugify(sourceRoot) || 'repo';
    const id = `slice-${slug}`;
    const rel = `${layout.vaultDirRel}/30-slices/${id}.md`;
    const summary = `Owned work for the ${sourceRoot}/ source tree.`;
    const body = [
      '---',
      `id: ${id}`,
      `title: ${yamlScalar(`Slice: ${sourceRoot}`)}`,
      'type: slice',
      'status: active',
      'owner: builder',
      `scope: ${scopeForPath(sourceRoot)}`,
      `updated: ${today(date)}`,
      `summary: ${yamlScalar(summary)}`,
      yamlList('paths', [`${sourceRoot}/**`]),
      '---',
      '',
      `# ${sourceRoot}/`,
      '',
      `Slice pointer for the ${sourceRoot}/ tree. Query with \`node ${layout.scriptsDirRel}/vault.mjs find --query ${sourceRoot}\`.`,
      '',
      OBSERVED_BEGIN,
      '## Observed files (derived)',
      '',
      `- \`${sourceRoot}/**\``,
      OBSERVED_END,
      '',
      'Back to [[map-repo]].',
      '',
    ].join('\n');
    entries.push({ id, rel, sourceRoot, content: body });
  }
  return entries;
}

/**
 * @param {ReturnType<typeof discoverProject>} project
 * @param {ReturnType<typeof resolveVaultLayout>} layout
 * @param {string[]} contractIds
 * @param {string[]} sliceIds
 */
function mapObservedBlock(project, layout, contractIds, sliceIds) {
  const lines = [
    OBSERVED_BEGIN,
    '## Observed layout (derived)',
    '',
    `- Source roots: ${project.srcRoots.map((root) => `\`${root}\``).join(', ') || 'repository root'}`,
    `- Validation: \`${project.testCmd}\``,
    `- Vault CLI: \`${layout.scriptsDirRel}/vault.mjs\``,
    '',
    '### Files observed (bounded)',
  ];

  if (project.files.length === 0) {
    lines.push('- No source files matched the bounded scan.');
  } else {
    for (const file of project.files.slice(0, MAX_MAP_FILES)) {
      const exportHint = file.exports
        .slice(0, 2)
        .map((entry) => `\`#${entry.name}\` L${entry.line}-L${entry.end_line}`)
        .join(', ');
      lines.push(`- \`${file.path}\` (${file.lines} lines${exportHint ? `; ${exportHint}` : ''})`);
    }
    if (project.files.length > MAX_MAP_FILES) {
      lines.push(`- ... and ${project.files.length - MAX_MAP_FILES} more observed file(s)`);
    }
  }

  if (contractIds.length > 0) {
    lines.push('', '### Contracts derived', ...contractIds.map((id) => `- [[${id}]]`));
  }
  if (sliceIds.length > 0) {
    lines.push('', '### Slices derived', ...sliceIds.map((id) => `- [[${id}]]`));
  }
  lines.push(OBSERVED_END);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Frontmatter / marker editing for update
 * ------------------------------------------------------------------ */

/**
 * @param {string} text
 * @param {string} key
 * @param {string} rendered
 */
function setFrontmatterBlock(text, key, rendered) {
  const original = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = original.split('\n');
  if (lines[0] !== '---') return { text: original, changed: false };
  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      closing = index;
      break;
    }
  }
  if (closing === -1) return { text: original, changed: false };

  const keyRx = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  let found = -1;
  for (let index = 1; index < closing; index += 1) {
    if (keyRx.test(lines[index])) {
      found = index;
      break;
    }
  }

  if (found === -1) {
    lines.splice(closing, 0, ...rendered.split('\n'));
  } else {
    let end = found + 1;
    while (end < closing && (/^\s+/.test(lines[end]) || /^\s*-/.test(lines[end]))) end += 1;
    lines.splice(found, end - found, ...rendered.split('\n'));
  }
  const next = lines.join('\n');
  return { text: next, changed: next !== original };
}

/**
 * @param {string} text
 * @param {string} block
 */
function replaceObservedBlock(text, block) {
  const original = String(text ?? '').replace(/\r\n/g, '\n');
  const start = original.indexOf(OBSERVED_BEGIN);
  if (start === -1) return { text: original, changed: false };
  const end = original.indexOf(OBSERVED_END, start + OBSERVED_BEGIN.length);
  if (end === -1) return { text: original, changed: false };
  const next = `${original.slice(0, start)}${block}${original.slice(end + OBSERVED_END.length)}`;
  return { text: next, changed: next !== original };
}

/**
 * @param {string} text
 * @param {Array<{ key: string, rendered: string }>} fields
 */
function applyFrontmatterFields(text, fields) {
  let current = text;
  let changed = false;
  for (const field of fields) {
    const result = setFrontmatterBlock(current, field.key, field.rendered);
    current = result.text;
    changed = changed || result.changed;
  }
  return { text: current, changed };
}

/* ------------------------------------------------------------------ *
 * Target preflight and atomic writes
 * ------------------------------------------------------------------ */

/** @param {string} rootReal @param {string} absPath */
function assertParentDirectories(rootReal, absPath) {
  let current = dirname(absPath);
  while (isWithinDir(rootReal, current) && current !== rootReal) {
    if (existsSync(current) && !statSync(current).isDirectory()) {
      throw new HiveContractError(
        EXIT_CODES.VALIDATION,
        ERROR_CODES.REFUSED,
        `parent path is not a directory: ${toPosixPath(relative(rootReal, current))}`,
      );
    }
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
}

/**
 * Preflight every target before the first write.
 * @param {string} rootReal
 * @param {ReturnType<typeof resolveVaultLayout>} layout
 * @param {Map<string, { content?: string, merge?: (existing: string) => string, mode?: string }>} targets
 */
function preflightTargets(rootReal, layout, targets) {
  const writes = [];
  const skipped = [];
  const seen = new Map();

  for (const [rel, entry] of [...targets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const safe = resolveSafePath(rootReal, rel, 'target');
    const relPosix = safe.relPosix;
    if (seen.has(relPosix)) {
      throw new HiveContractError(
        EXIT_CODES.VALIDATION,
        ERROR_CODES.REFUSED,
        `target collision: ${relPosix} produced by ${seen.get(relPosix)} and ${rel}`,
      );
    }
    seen.set(relPosix, rel);
    if (!isOwnedTarget(relPosix, layout)) {
      throw new HiveContractError(
        EXIT_CODES.VALIDATION,
        ERROR_CODES.REFUSED,
        `refusing to write outside lifecycle-owned paths: ${relPosix}`,
      );
    }
    assertParentDirectories(rootReal, safe.absPath);

    let lst = null;
    try {
      lst = lstatSync(safe.absPath);
    } catch {
      lst = null;
    }

    if (lst) {
      if (lst.isSymbolicLink()) {
        throw new HiveContractError(
          EXIT_CODES.VALIDATION,
          ERROR_CODES.REFUSED,
          `refusing to write through symlink target: ${relPosix}`,
        );
      }
      if (lst.isDirectory()) {
        throw new HiveContractError(
          EXIT_CODES.VALIDATION,
          ERROR_CODES.REFUSED,
          `target collision: expected a file but found a directory: ${relPosix}`,
        );
      }
      if (!lst.isFile()) {
        throw new HiveContractError(
          EXIT_CODES.VALIDATION,
          ERROR_CODES.REFUSED,
          `target is not a regular file: ${relPosix}`,
        );
      }
    }

    const mode = entry.mode ?? 'create';
    if (lst && mode === 'create') {
      if (relPosix.startsWith(`${layout.scriptsDirRel}/`) &&
          typeof entry.content === 'string' &&
          readBoundedUtf8(safe.absPath, { rootReal }) !== entry.content) {
        throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED,
          `target collision: existing script differs from the vault kit: ${relPosix}`);
      }
      skipped.push(relPosix);
      continue;
    }

    let content = entry.content;
    if (entry.merge) {
      const existing = lst ? readBoundedUtf8(safe.absPath, { rootReal }) : '';
      content = entry.merge(existing);
      if (lst && content === existing) {
        skipped.push(relPosix);
        continue;
      }
    }
    if (typeof content !== 'string') continue;
    writes.push({ relPosix, absPath: safe.absPath, content });
  }

  return { writes, skipped };
}

/** @param {{ relPosix: string, content: string }[]} writes */
function commitWrites(writes) {
  for (const write of writes) {
    atomicWriteUtf8(write.absPath, write.content);
  }
}

/* ------------------------------------------------------------------ *
 * Template target construction
 * ------------------------------------------------------------------ */

/**
 * @param {string} rootReal
 * @param {ReturnType<typeof resolveVaultLayout>} layout
 * @param {Record<string, string>} values
 */
function buildTemplateTargets(rootReal, layout, values) {
  const base = templateDir();
  if (!existsSync(base)) {
    throw new HiveContractError(
      EXIT_CODES.NOT_FOUND,
      ERROR_CODES.TEMPLATE_INVALID,
      `vault-kit template not found at ${base}`,
    );
  }
  const targets = new Map();
  const snippetFile = join(base, 'AGENTS.vault-snippet.md');
  const agentsSnippet = existsSync(snippetFile)
    ? renderTemplateContent(readBoundedUtf8(snippetFile, { rootReal, maxBytes: MAX_SCAN_BYTES }), values, '.md', layout)
    : null;

  /** @param {string} absDir @param {string} relDir */
  const walk = (absDir, relDir) => {
    const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      const rel = toPosixPath(relDir === '' ? entry.name : `${relDir}/${entry.name}`);
      if (entry.isSymbolicLink()) {
        throw new HiveContractError(
          EXIT_CODES.VALIDATION,
          ERROR_CODES.TEMPLATE_INVALID,
          `symlink in vault-kit template: ${rel}`,
        );
      }
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (rel === 'AGENTS.vault-snippet.md') continue;
      const targetRel = mapTemplateTarget(rel, layout);
      if (!targetRel) continue;
      if (targets.has(targetRel)) {
        throw new HiveContractError(
          EXIT_CODES.VALIDATION,
          ERROR_CODES.TEMPLATE_INVALID,
          `template target collision: ${targetRel}`,
        );
      }
      const text = readBoundedUtf8(abs, { rootReal, maxBytes: MAX_SCAN_BYTES });
      targets.set(targetRel, {
        content: renderTemplateContent(text, values, extname(rel), layout),
        mode: 'create',
      });
    }
  };
  walk(base, '');
  return { targets, agentsSnippet };
}

/**
 * @param {string} layout
 * @param {Record<string,string>} values
 * @param {string} agentsSnippet
 */
function buildAgentsMerge(agentsSnippet) {
  const begin = AGENTS_VAULT_MARKERS.BEGIN;
  const end = AGENTS_VAULT_MARKERS.END;
  return (existing) => {
    const snippet = `${agentsSnippet.replace(/\s+$/, '')}\n`;
    const start = existing.indexOf(begin);
    const stop = existing.indexOf(end, start + begin.length);
    if (start !== -1 && stop !== -1) {
      return `${existing.slice(0, start)}${snippet}${existing.slice(stop + end.length)}`;
    }
    if (start !== -1 || stop !== -1) {
      refuse('AGENTS.md has an unterminated context-vault block; repair it manually before scaffolding');
    }
    if (existing.trim() === '') return snippet;
    return `${existing.replace(/\s+$/, '')}\n\n${snippet}`;
  };
}

/**
 * @param {ReturnType<typeof resolveVaultLayout>} layout
 */
function requiredGitignoreEntries(layout) {
  return [`${layout.vaultDirRel}/.index/`, `${layout.vaultDirRel}/90-handoffs/`, '.hive/'];
}

/** @param {ReturnType<typeof resolveVaultLayout>} layout */
function buildGitignoreMerge(layout) {
  const required = requiredGitignoreEntries(layout);
  return (existing) => {
    const text = String(existing ?? '').replace(/\r\n/g, '\n');
    const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
    let changed = false;
    for (const entry of required) {
      if (!lines.some((line) => line.trim() === entry)) {
        lines.push(entry);
        changed = true;
      }
    }
    if (!changed && text !== '') return text;
    return `${lines.join('\n')}\n`;
  };
}

/* ------------------------------------------------------------------ *
 * Vault command execution + verification
 * ------------------------------------------------------------------ */

/**
 * @param {string} rootReal
 * @param {ReturnType<typeof resolveVaultLayout>} layout
 * @param {string} command
 * @param {string[]} [extra]
 */
function runVaultCli(rootReal, layout, command, extra = []) {
  if (!existsSync(layout.cliSentinelAbs)) {
    throw new HiveContractError(
      EXIT_CODES.NOT_FOUND,
      ERROR_CODES.NOT_FOUND,
      `vault CLI not found: ${layout.cliSentinelRel}`,
    );
  }
  const result = spawnSync(
    process.execPath,
    [layout.cliSentinelAbs, command, ...extra, '--json', '--root', rootReal, '--vault-dir', layout.vaultDirRel],
    {
      cwd: rootReal,
      encoding: 'utf8',
      timeout: 60000,
      shell: false,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    },
  );
  return {
    exit: typeof result.status === 'number' && result.status >= 0 ? result.status : 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** @param {string} text */
function parseJsonPayload(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line.startsWith('{') || !line.endsWith('}')) continue;
      try {
        return JSON.parse(line);
      } catch {
        // keep scanning
      }
    }
    return null;
  }
}

/**
 * @param {string} rootReal
 * @param {ReturnType<typeof resolveVaultLayout>} layout
 */
function verifyObserved(rootReal, layout) {
  const index = runVaultCli(rootReal, layout, 'index');
  const check = runVaultCli(rootReal, layout, 'check', ['--strict']);
  return {
    index_exit: index.exit,
    check_exit: check.exit,
    ok: index.exit === EXIT_CODES.OK && check.exit === EXIT_CODES.OK,
    index: parseJsonPayload(index.stdout),
    check: parseJsonPayload(check.stdout),
    index_error: index.exit === EXIT_CODES.OK ? null : (parseJsonPayload(index.stderr)?.error ?? null),
    check_error: check.exit === EXIT_CODES.OK ? null : (parseJsonPayload(check.stderr)?.error ?? null),
  };
}

/* ------------------------------------------------------------------ *
 * State file handling
 * ------------------------------------------------------------------ */

/**
 * @param {string} rootReal
 * @param {string} goalId
 */
function stateFilePath(rootReal, goalId) {
  const safe = resolveSafePath(rootReal, `${LIFECYCLE_DIR}/${goalId}.json`, 'lifecycle state');
  return safe;
}

/**
 * @param {string} rootReal
 * @param {string} goalId
 */
function readStateRecord(rootReal, goalId) {
  const safe = stateFilePath(rootReal, goalId);
  if (!existsSync(safe.absPath)) return null;
  let text;
  try {
    text = readBoundedUtf8(safe.absPath, { rootReal, maxBytes: 64 * 1024 });
  } catch (error) {
    throw new HiveContractError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.STATE_CORRUPT,
      `corrupt lifecycle state at ${safe.relPosix}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HiveContractError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.STATE_CORRUPT,
      `corrupt lifecycle state at ${safe.relPosix}: invalid JSON`,
    );
  }
  const validChoice = parsed?.choice === 'yes' || parsed?.choice === 'no';
  const validPrompt = parsed?.prompt === null || parsed?.prompt === 'create' || parsed?.prompt === 'update';
  const validExits = ['scaffold_exit', 'index_exit', 'check_exit'].every((key) => {
    if (!(key in (parsed ?? {}))) return true;
    return Number.isInteger(parsed[key]) && parsed[key] >= 0 && parsed[key] <= 255;
  });
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.schema_version !== SCHEMA_VERSION ||
    parsed.goal_id !== goalId ||
    !validChoice ||
    !validPrompt ||
    !validExits
  ) {
    throw new HiveContractError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.STATE_CORRUPT,
      `corrupt lifecycle state at ${safe.relPosix}: schema or values invalid`,
    );
  }
  return { record: parsed, relPosix: safe.relPosix };
}

/** @param {unknown} value @param {string} label */
function parseExitCodeFlag(value, label) {
  if (value === undefined) return undefined;
  const raw = String(value).trim();
  if (!/^\d{1,3}$/.test(raw)) refuse(`invalid --${label}: ${raw || '<empty>'}`);
  const numeric = Number(raw);
  if (numeric > 255) refuse(`invalid --${label}: ${raw}`);
  return numeric;
}

/* ------------------------------------------------------------------ *
 * Public lifecycle API
 * ------------------------------------------------------------------ */

/** @param {{ root?: string, vaultDir?: string }} [options] */
export function detectLifecycle(options = {}) {
  const rootReal = resolveRootDir(options.root);
  return detectVault({ root: rootReal, vaultDir: options.vaultDir });
}

/**
 * @param {{ root?: string, goal?: string, vaultDir?: string, env?: Record<string, string | undefined> }} [options]
 */
export function planLifecycle(options = {}) {
  const rootReal = resolveRootDir(options.root);
  const goalId = validateGoalId(options.goal);
  const layout = resolveVaultLayout(rootReal, options.vaultDir);
  const detection = detectVault({ root: rootReal, vaultDir: options.vaultDir });
  const stored = readStateRecord(rootReal, goalId);

  const base = {
    goal_id: goalId,
    state: detection.state,
    vault_dir: detection.vault_dir,
    missing: detection.missing,
    ci_auto_no: false,
    answered: false,
    action: PLAN_ACTIONS.NONE,
    question: null,
  };

  if (stored) {
    return {
      ...base,
      answered: true,
      reason: 'already_answered',
      record: stored.record,
      record_path: stored.relPosix,
    };
  }

  const env = options.env ?? process.env;
  if (isCiEnvironment(env)) {
    return {
      ...base,
      ci_auto_no: true,
      reason: 'ci_auto_no',
      record: null,
      record_path: stateFilePath(rootReal, goalId).relPosix,
    };
  }

  const flow = detection.state === VAULT_STATES.PRESENT_HEALTHY || detection.state === VAULT_STATES.PRESENT_UNHEALTHY
    ? 'update'
    : 'create';
  const promptPlan = buildPromptPlan({
    flow,
    state: detection.state,
    vaultDir: layout.vaultDirRel,
    missing: detection.missing,
    env: {},
  });

  return {
    ...base,
    action: flow === 'create' ? PLAN_ACTIONS.PROMPT_CREATE : PLAN_ACTIONS.PROMPT_UPDATE,
    flow,
    question: promptPlan.question,
    reason: 'unanswered',
    record: null,
    record_path: stateFilePath(rootReal, goalId).relPosix,
  };
}

/**
 * @param {{ root?: string, vaultDir?: string, yes?: boolean, date?: string }} [options]
 */
export function scaffoldVault(options = {}) {
  const rootReal = resolveRootDir(options.root);
  const layout = resolveVaultLayout(rootReal, options.vaultDir);
  if (!options.yes) {
    refuse('scaffold requires --yes (consent to write .opencode/vault and the vault CLI)');
  }
  const detection = detectVault({ root: rootReal, vaultDir: options.vaultDir });
  if (detection.state === VAULT_STATES.PRESENT_HEALTHY) {
    throw new HiveContractError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.REFUSED,
      'vault is already healthy; use update --yes to refresh pointers',
    );
  }

  const project = discoverProject(rootReal, layout);
  const date = today(options.date);
  const values = {
    PROJECT_NAME: project.projectName,
    PROJECT_ONE_LINER: project.oneLiner,
    STACK: project.stack,
    SRC_DIRS: project.srcRoots.join(', ') || 'repository root',
    TEST_CMD: project.testCmd,
    VAULT_DIR: layout.vaultDirRel,
    DATE: date,
  };
  const { targets, agentsSnippet } = buildTemplateTargets(rootReal, layout, values);
  if (!agentsSnippet) {
    throw new HiveContractError(
      EXIT_CODES.NOT_FOUND,
      ERROR_CODES.TEMPLATE_INVALID,
      'vault-kit template is missing AGENTS.vault-snippet.md',
    );
  }
  targets.set('AGENTS.md', { merge: buildAgentsMerge(agentsSnippet), mode: 'merge' });
  targets.set('.gitignore', { merge: buildGitignoreMerge(layout), mode: 'merge' });

  const mapRel = `${layout.vaultDirRel}/10-map/map-repo.md`;
  const derived = { contracts: [], slices: [] };
  if (!existsSync(resolve(rootReal, mapRel))) {
    derived.contracts = deriveContractEntries(
      project,
      layout,
      date,
      new Set(),
      MAX_CONTRACTS,
    );
    const existingRoots = new Set();
    derived.slices = deriveSliceEntries(project, layout, date, existingRoots, MAX_SLICES);
    for (const entry of [...derived.contracts, ...derived.slices]) {
      targets.set(entry.rel, { content: entry.content, mode: 'create' });
    }
    const mapTarget = targets.get(mapRel);
    if (mapTarget) {
      const block = mapObservedBlock(
        project,
        layout,
        derived.contracts.map((entry) => entry.id),
        derived.slices.map((entry) => entry.id),
      );
      mapTarget.content = `${String(mapTarget.content).replace(/\s+$/, '')}\n\n${block}\n`;
    }
  }

  const { writes, skipped } = preflightTargets(rootReal, layout, targets);
  commitWrites(writes);
  const observed = verifyObserved(rootReal, layout);
  const postState = detectVault({ root: rootReal, vaultDir: options.vaultDir });

  return {
    action: 'scaffold',
    ok: observed.ok,
    vault_dir: layout.vaultDirRel,
    scripts_dir: layout.scriptsDirRel,
    state: postState.state,
    created: writes.map((write) => write.relPosix),
    skipped,
    derived_contracts: derived.contracts.map((entry) => entry.id),
    derived_slices: derived.slices.map((entry) => entry.id),
    index_exit: observed.index_exit,
    check_exit: observed.check_exit,
    observed,
  };
}

/**
 * Collect authored vault markdown notes, excluding generated/runtime folders.
 * @param {string} rootReal
 * @param {ReturnType<typeof resolveVaultLayout>} layout
 */
function collectVaultNotes(rootReal, layout) {
  const notes = new Map();
  const vaultAbs = layout.vaultDirAbs;
  if (!existsSync(vaultAbs)) return notes;
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
      const abs = join(absDir, entry.name);
      const relFromVault = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs, relFromVault);
        continue;
      }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue;
      if (relFromVault === 'README.md') continue;
      let text;
      try {
        text = readBoundedUtf8(abs, { rootReal, maxBytes: MAX_SCAN_BYTES });
      } catch {
        continue;
      }
      const rel = toPosixPath(`${layout.vaultDirRel}/${relFromVault}`);
      const parsed = parseNote(text, { filePath: rel });
      notes.set(rel, { rel, abs, text, parsed });
    }
  };
  walk(vaultAbs, '');
  return notes;
}

/**
 * @param {Map<string, { rel: string, abs: string, text: string, parsed: any }>} notes
 * @param {string} type
 */
function noteIdsOfType(notes, type) {
  return [...notes.values()]
    .filter((note) => note.parsed.frontmatter.type === type)
    .map((note) => String(note.parsed.frontmatter.id ?? ''))
    .filter(Boolean)
    .sort();
}

/**
 * @param {Map<string, any>} notes
 * @param {string} type
 */
function markerNotePathsOfType(notes, type) {
  const paths = new Set();
  for (const note of notes.values()) {
    if (note.parsed.frontmatter.type !== type) continue;
    if (!note.text.includes(OBSERVED_BEGIN)) continue;
    const notePaths = Array.isArray(note.parsed.frontmatter.paths) ? note.parsed.frontmatter.paths : [];
    for (const item of notePaths) {
      if (typeof item === 'string' && !/[*?]/.test(item)) paths.add(item);
    }
  }
  return paths;
}

/**
 * @param {{ root?: string, vaultDir?: string, yes?: boolean, goal?: string, date?: string }} [options]
 */
export function updateVault(options = {}) {
  const rootReal = resolveRootDir(options.root);
  const layout = resolveVaultLayout(rootReal, options.vaultDir);
  if (!options.yes) {
    refuse('update requires --yes (consent to rewrite drifted vault pointer notes)');
  }
  const detection = detectVault({ root: rootReal, vaultDir: options.vaultDir });
  if (detection.state === VAULT_STATES.ABSENT) {
    throw new HiveContractError(
      EXIT_CODES.NOT_FOUND,
      ERROR_CODES.NOT_FOUND,
      'no vault found to update; run scaffold --yes first',
    );
  }
  if (!existsSync(layout.cliSentinelAbs) || !existsSync(layout.mocSentinelAbs)) {
    throw new HiveContractError(
      EXIT_CODES.NOT_FOUND,
      ERROR_CODES.NOT_FOUND,
      'vault is partial; run scaffold --yes to repair missing sentinels before update',
    );
  }

  const project = discoverProject(rootReal, layout);
  const date = today(options.date);
  const notes = collectVaultNotes(rootReal, layout);
  const mapRel = `${layout.vaultDirRel}/10-map/map-repo.md`;
  const mapNote = notes.get(mapRel);
  const canDerive = Boolean(mapNote && mapNote.text.includes(OBSERVED_BEGIN));

  const targets = new Map();
  const deleted = [];
  const refreshed = [];
  const skipped = [];
  const newContracts = [];
  const newSlices = [];

  const coveredContractPaths = markerNotePathsOfType(notes, 'contract');
  const coveredSliceRoots = new Set();
  for (const note of notes.values()) {
    if (note.parsed.frontmatter.type !== 'slice') continue;
    if (!note.text.includes(OBSERVED_BEGIN)) continue;
    const paths = Array.isArray(note.parsed.frontmatter.paths) ? note.parsed.frontmatter.paths : [];
    for (const item of paths) {
      if (typeof item !== 'string') continue;
      const match = /^([^/*?]+)\/\*\*$/.exec(item);
      if (match) coveredSliceRoots.add(match[1]);
    }
  }

  // Refresh existing derived contract notes; delete only when the file is gone.
  for (const note of notes.values()) {
    if (note.parsed.frontmatter.type !== 'contract') continue;
    if (!note.text.includes(OBSERVED_BEGIN)) continue;
    const paths = Array.isArray(note.parsed.frontmatter.paths) ? note.parsed.frontmatter.paths : [];
    const exact = paths.filter((item) => typeof item === 'string' && !/[*?]/.test(item));
    if (exact.length !== 1) continue;
    const pointer = exact[0];
    let safe;
    try {
      safe = resolveSafePath(rootReal, pointer, 'contract pointer');
    } catch {
      deleted.push(note.rel);
      continue;
    }
    if (!existsSync(safe.absPath) || !statSync(safe.absPath).isFile()) {
      deleted.push(note.rel);
      continue;
    }
    let text;
    try {
      text = readBoundedUtf8(safe.absPath, { rootReal, maxBytes: MAX_SCAN_BYTES });
    } catch {
      continue;
    }
    const lang = extname(pointer).replace('.', '').toLowerCase();
    const scanned = scanSourceFile(text, lang);
    if (scanned.exports.length === 0) {
      deleted.push(note.rel);
      continue;
    }
    const exports = scanned.exports.slice(0, MAX_EXPORTS_PER_NOTE);
    let next = applyFrontmatterFields(note.text, [
      { key: 'updated', rendered: `updated: ${date}` },
      { key: 'symbols', rendered: yamlList('symbols', exports.map((entry) => entry.name)) },
      { key: 'source_hash', rendered: `source_hash: ${sha256Hex(text)}` },
    ]);
    const replaced = replaceObservedBlock(next.text, contractObservedBlock(pointer, exports));
    next = { text: replaced.text, changed: next.changed || replaced.changed };
    if (next.changed) {
      targets.set(note.rel, { content: next.text, mode: 'replace' });
      refreshed.push(note.rel);
    } else {
      skipped.push(note.rel);
    }
  }

  // Refresh existing derived slice notes; delete only when the source root vanished.
  for (const note of notes.values()) {
    if (note.parsed.frontmatter.type !== 'slice') continue;
    if (!note.text.includes(OBSERVED_BEGIN)) continue;
    const paths = Array.isArray(note.parsed.frontmatter.paths) ? note.parsed.frontmatter.paths : [];
    const globs = paths.filter((item) => typeof item === 'string' && /\*/.test(item));
    if (globs.length === 0) continue;
    const stillExists = globs.some((pattern) => {
      const match = /^([^/*?]+)\/\*\*$/.exec(pattern);
      if (!match) return true;
      try {
        return existsSync(resolveSafePath(rootReal, match[1], 'slice pointer').absPath);
      } catch {
        return false;
      }
    });
    if (!stillExists) {
      deleted.push(note.rel);
      continue;
    }
    const next = setFrontmatterBlock(note.text, 'updated', `updated: ${date}`);
    if (next.changed) {
      targets.set(note.rel, { content: next.text, mode: 'replace' });
      refreshed.push(note.rel);
    }
  }

  if (canDerive) {
    const existingContractCount = noteIdsOfType(notes, 'contract').length;
    const remainingContracts = Math.max(0, MAX_CONTRACTS - existingContractCount);
    newContracts.push(
      ...deriveContractEntries(project, layout, date, coveredContractPaths, remainingContracts),
    );
    const remainingSlices = Math.max(0, MAX_SLICES - coveredSliceRoots.size);
    newSlices.push(...deriveSliceEntries(project, layout, date, coveredSliceRoots, remainingSlices));
    for (const entry of [...newContracts, ...newSlices]) {
      targets.set(entry.rel, { content: entry.content, mode: 'create' });
    }

    const survivingNotes = new Map(notes);
    for (const rel of deleted) survivingNotes.delete(rel);
    for (const entry of newContracts) {
      survivingNotes.set(entry.rel, {
        rel: entry.rel,
        text: entry.content,
        parsed: { frontmatter: { id: entry.id, type: 'contract' } },
      });
    }
    for (const entry of newSlices) {
      survivingNotes.set(entry.rel, {
        rel: entry.rel,
        text: entry.content,
        parsed: { frontmatter: { id: entry.id, type: 'slice' } },
      });
    }
    const contractIds = noteIdsOfType(survivingNotes, 'contract');
    const sliceIds = noteIdsOfType(survivingNotes, 'slice');
    const block = mapObservedBlock(project, layout, contractIds, sliceIds);
    const replacedMap = replaceObservedBlock(mapNote.text, block);
    const mapNext = applyFrontmatterFields(replacedMap.text, [{ key: 'updated', rendered: `updated: ${date}` }]);
    if (replacedMap.changed || mapNext.changed) {
      targets.set(mapRel, { content: mapNext.text, mode: 'replace' });
      refreshed.push(mapRel);
    }
  }

  const deletePaths = [];
  for (const rel of deleted) {
    const safe = resolveSafePath(rootReal, rel, 'derived note');
    if (!isOwnedTarget(safe.relPosix, layout)) {
      refuse(`refusing to delete outside lifecycle-owned paths: ${safe.relPosix}`);
    }
    deletePaths.push(safe.absPath);
  }

  const { writes, skipped: preflightSkipped } = preflightTargets(rootReal, layout, targets);
  for (const absPath of deletePaths) {
    try {
      if (existsSync(absPath)) unlinkSync(absPath);
    } catch {
      throw new HiveContractError(
        EXIT_CODES.INTERNAL,
        ERROR_CODES.INTERNAL,
        `failed to delete stale derived note: ${toPosixPath(relative(rootReal, absPath))}`,
      );
    }
  }
  commitWrites(writes);
  const observed = verifyObserved(rootReal, layout);
  const postState = detectVault({ root: rootReal, vaultDir: options.vaultDir });

  return {
    action: 'update',
    ok: observed.ok,
    vault_dir: layout.vaultDirRel,
    scripts_dir: layout.scriptsDirRel,
    state: postState.state,
    refreshed: [...new Set([...refreshed, ...writes.map((write) => write.relPosix)])],
    created: [...newContracts, ...newSlices].map((entry) => entry.rel),
    deleted: deleted.map((rel) => toPosixPath(rel)),
    skipped: [...new Set([...skipped, ...preflightSkipped])],
    derived_contracts: newContracts.map((entry) => entry.id),
    derived_slices: newSlices.map((entry) => entry.id),
    index_exit: observed.index_exit,
    check_exit: observed.check_exit,
    observed,
  };
}

/**
 * @param {{ root?: string, vaultDir?: string }} [options]
 */
export function verifyVault(options = {}) {
  const rootReal = resolveRootDir(options.root);
  const layout = resolveVaultLayout(rootReal, options.vaultDir);
  const observed = verifyObserved(rootReal, layout);
  const postState = detectVault({ root: rootReal, vaultDir: options.vaultDir });
  return {
    action: 'verify',
    ok: observed.ok,
    state: postState.state,
    vault_dir: layout.vaultDirRel,
    scripts_dir: layout.scriptsDirRel,
    index_exit: observed.index_exit,
    check_exit: observed.check_exit,
    observed,
  };
}

/**
 * @param {{ root?: string, goal?: string }} [options]
 */
export function getLifecycleState(options = {}) {
  const rootReal = resolveRootDir(options.root);
  const goalId = validateGoalId(options.goal);
  const stored = readStateRecord(rootReal, goalId);
  const safe = stateFilePath(rootReal, goalId);
  return {
    goal_id: goalId,
    exists: Boolean(stored),
    answered: Boolean(stored?.record?.choice),
    record: stored?.record ?? null,
    record_path: safe.relPosix,
  };
}

/**
 * @param {{
 *   root?: string,
 *   goal?: string,
 *   choice?: string,
 *   prompt?: string,
 *   scaffoldExit?: string | number,
 *   indexExit?: string | number,
 *   checkExit?: string | number,
 * }} [options]
 */
export function recordLifecycleState(options = {}) {
  const rootReal = resolveRootDir(options.root);
  const goalId = validateGoalId(options.goal);
  const choice = String(options.choice ?? '').trim().toLowerCase();
  if (choice !== 'yes' && choice !== 'no') {
    refuse(`invalid --choice: ${choice || '<empty>'} (expected yes or no)`);
  }
  let prompt = null;
  if (options.prompt !== undefined && options.prompt !== null && String(options.prompt).trim() !== '') {
    const value = String(options.prompt).trim().toLowerCase();
    if (value !== 'create' && value !== 'update') {
      refuse(`invalid --prompt: ${value} (expected create or update)`);
    }
    prompt = value;
  }

  const scaffoldExit = parseExitCodeFlag(options.scaffoldExit, 'scaffold-exit');
  const indexExit = parseExitCodeFlag(options.indexExit, 'index-exit');
  const checkExit = parseExitCodeFlag(options.checkExit, 'check-exit');

  const record = {
    schema_version: SCHEMA_VERSION,
    goal_id: goalId,
    prompt,
    choice,
    recorded_at: new Date().toISOString(),
  };
  if (scaffoldExit !== undefined) record.scaffold_exit = scaffoldExit;
  if (indexExit !== undefined) record.index_exit = indexExit;
  if (checkExit !== undefined) record.check_exit = checkExit;

  const safe = stateFilePath(rootReal, goalId);
  atomicWriteUtf8(safe.absPath, `${JSON.stringify(record, null, 2)}\n`);
  return {
    goal_id: goalId,
    answered: true,
    record,
    record_path: safe.relPosix,
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

/**
 * @param {ReturnType<typeof planLifecycle>} plan
 */
function humanPlan(plan) {
  if (plan.action === PLAN_ACTIONS.NONE) {
    return `vault plan: ${plan.action} (${plan.reason})\n`;
  }
  if (!plan.question) return `vault plan: ${plan.action}\n`;
  return [
    `vault state: ${plan.state}`,
    `action: ${plan.action}`,
    `[${plan.question.header}]`,
    plan.question.question,
    '',
  ].join('\n');
}

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined> }} [runtime]
 * @returns {number}
 */
export function runCli(argv, runtime = {}) {
  let ctx = {
    json: Array.isArray(argv) && argv.includes('--json'),
    quiet: Array.isArray(argv) && (argv.includes('--quiet') || argv.includes('-q')),
  };
  const env = runtime.env ?? process.env;

  try {
    const { flags, positionals } = parseCliArgs(argv);
    ctx = { json: Boolean(flags.json), quiet: Boolean(flags.quiet) };
    if (flags.help) {
      emitSuccess({ ...ctx, json: false }, { usage: USAGE }, `${USAGE}\n`);
      return EXIT_CODES.OK;
    }

    const command = positionals[0];
    if (command === undefined) refuse('missing command (expected detect, plan, scaffold, update, verify, or state)');
    if (flags['vault-dir'] === true) refuse('--vault-dir requires a path value');
    if (flags.root === true) refuse('--root requires a directory value');
    const root = flags.root;
    const vaultDir = flags['vault-dir'];

    if (command === 'detect') {
      if (positionals.length > 1) refuse(`unexpected argument: ${positionals[1]}`);
      const data = detectLifecycle({ root, vaultDir });
      emitSuccess(ctx, data, `vault state: ${data.state}\nvault dir: ${data.vault_dir}\n`);
      return EXIT_CODES.OK;
    }

    if (command === 'plan') {
      if (positionals.length > 1) refuse(`unexpected argument: ${positionals[1]}`);
      const data = planLifecycle({ root, goal: flags.goal, vaultDir, env });
      emitSuccess(ctx, data, humanPlan(data));
      return EXIT_CODES.OK;
    }

    if (command === 'scaffold') {
      if (positionals.length > 1) refuse(`unexpected argument: ${positionals[1]}`);
      const data = scaffoldVault({ root, vaultDir, yes: flags.yes === true || flags.yes === 'true' });
      emitSuccess(
        ctx,
        data,
        `vault scaffold: ${data.ok ? 'ok' : 'failed'} (index=${data.index_exit} check=${data.check_exit})\n`,
      );
      return data.ok ? EXIT_CODES.OK : (data.check_exit || data.index_exit || EXIT_CODES.INTERNAL);
    }

    if (command === 'update') {
      if (positionals.length > 1) refuse(`unexpected argument: ${positionals[1]}`);
      if (flags.goal !== undefined && typeof flags.goal !== 'string') refuse('--goal requires a value');
      if (flags.goal !== undefined) validateGoalId(flags.goal);
      const data = updateVault({ root, vaultDir, goal: flags.goal, yes: flags.yes === true || flags.yes === 'true' });
      emitSuccess(
        ctx,
        data,
        `vault update: ${data.ok ? 'ok' : 'failed'} (index=${data.index_exit} check=${data.check_exit})\n`,
      );
      return data.ok ? EXIT_CODES.OK : (data.check_exit || data.index_exit || EXIT_CODES.INTERNAL);
    }

    if (command === 'verify') {
      if (positionals.length > 1) refuse(`unexpected argument: ${positionals[1]}`);
      const data = verifyVault({ root, vaultDir });
      emitSuccess(
        ctx,
        data,
        `vault verify: ${data.ok ? 'ok' : 'failed'} (index=${data.index_exit} check=${data.check_exit})\n`,
      );
      return data.ok ? EXIT_CODES.OK : (data.check_exit || data.index_exit || EXIT_CODES.INTERNAL);
    }

    if (command === 'state') {
      const subcommand = positionals[1];
      if (positionals.length > 2) refuse(`unexpected argument: ${positionals[2]}`);
      if (subcommand === 'get') {
        const data = getLifecycleState({ root, goal: flags.goal });
        emitSuccess(
          ctx,
          data,
          data.exists
            ? `goal ${data.goal_id}: choice=${data.record.choice} prompt=${data.record.prompt ?? 'none'}\n`
            : `goal ${data.goal_id}: no lifecycle record\n`,
        );
        return EXIT_CODES.OK;
      }
      if (subcommand === 'record') {
        if (flags.goal === true) refuse('--goal requires a value');
        if (flags.choice === true) refuse('--choice requires a value');
        if (flags.prompt === true) refuse('--prompt requires a value');
        const data = recordLifecycleState({
          root,
          goal: flags.goal,
          choice: flags.choice,
          prompt: flags.prompt,
          scaffoldExit: flags['scaffold-exit'],
          indexExit: flags['index-exit'],
          checkExit: flags['check-exit'],
        });
        emitSuccess(
          ctx,
          data,
          `goal ${data.goal_id}: recorded choice=${data.record.choice} prompt=${data.record.prompt ?? 'none'}\n`,
        );
        return EXIT_CODES.OK;
      }
      refuse('state requires get or record');
    }

    refuse(`unknown command: ${command} (expected detect, plan, scaffold, update, verify, or state)`);
  } catch (error) {
    if (error instanceof HiveContractError) {
      return emitFailure(ctx, error.code, error.message, error.exitCode);
    }
    const message = error instanceof Error ? error.message : String(error);
    return emitFailure(ctx, ERROR_CODES.INTERNAL, message, EXIT_CODES.INTERNAL);
  }
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const left = process.platform === 'win32' ? resolve(entry).toLowerCase() : resolve(entry);
    const right = process.platform === 'win32'
      ? fileURLToPath(import.meta.url).toLowerCase()
      : fileURLToPath(import.meta.url);
    return left === right;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2));
}
