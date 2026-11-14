import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  computeIndexSourceHash,
  emitSuccess,
  readBoundedBuffer,
  readBoundedUtf8,
  resolveSafePath,
  sha256Hex,
} from '../shared.mjs';
import { vaultNoteStats } from '../validate.mjs';

/**
 * Compare the on-disk index against current files and vault notes.
 * @param {string} rootDir
 * @returns { { status: 'missing' | 'stale' | 'fresh', index: Record<string, unknown> | null } }
 */
function indexStatus(rootDir, indexRelPath) {
  const indexPath = resolve(rootDir, indexRelPath);
  if (!existsSync(indexPath)) return { status: 'missing', index: null };

  /** @type {Record<string, unknown>} */
  let index;
  try {
    const parsed = JSON.parse(readBoundedUtf8(indexPath, { rootReal: rootDir, maxBytes: 8 * 1024 * 1024 }));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'stale', index: null };
    }
    index = parsed;
  } catch {
    return { status: 'stale', index: null };
  }

  const files = Array.isArray(index.files) ? index.files : [];
  const indexNotes = Array.isArray(index.notes) ? index.notes : [];

  if (typeof index.source_hash !== 'string' || files.length === 0) {
    /* An index with no files has a valid empty source hash; an absent one is stale. */
    if (typeof index.source_hash !== 'string') return { status: 'stale', index };
  }

  const normalizedFiles = files
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({ path: String(entry.path ?? ''), hash: String(entry.hash ?? '') }));
  if (computeIndexSourceHash(normalizedFiles) !== index.source_hash) {
    return { status: 'stale', index };
  }

  for (const entry of normalizedFiles) {
    const { absPath: abs } = resolveSafePath(rootDir, entry.path);
    if (!existsSync(abs)) return { status: 'stale', index };
    if (sha256Hex(readBoundedBuffer(abs, { rootReal: rootDir })) !== entry.hash) return { status: 'stale', index };
  }

  for (const note of indexNotes) {
    if (!note || typeof note !== 'object') continue;
    const { absPath: abs } = resolveSafePath(rootDir, String(note.path ?? ''));
    if (!existsSync(abs)) return { status: 'stale', index };
    if (typeof note.bytes === 'number' && statSync(abs).size !== note.bytes) {
      return { status: 'stale', index };
    }
  }

  return { status: 'fresh', index };
}

/**
 * @param {Record<string, unknown> | null} index
 */
function indexedCounts(index) {
  if (!index) return { files: 0, symbols: 0 };
  const files = Array.isArray(index.files) ? index.files.length : 0;
  const stats = index.stats && typeof index.stats === 'object' ? index.stats : null;
  const symbolsFromStats =
    stats && typeof stats.symbols === 'number' && Number.isFinite(stats.symbols) ? stats.symbols : null;
  const filesFromStats =
    stats && typeof stats.files === 'number' && Number.isFinite(stats.files) ? stats.files : null;

  let symbolCount = 0;
  if (index.symbols && typeof index.symbols === 'object' && !Array.isArray(index.symbols)) {
    for (const value of Object.values(index.symbols)) {
      if (Array.isArray(value)) symbolCount += value.length;
    }
  }

  return {
    files: filesFromStats ?? files,
    symbols: symbolsFromStats ?? symbolCount,
  };
}

/**
 * Report index freshness, counts, and the ten largest authored notes.
 * @param { { root: string, flags: Record<string, string | boolean>, positionals: string[], json: boolean, quiet: boolean } } ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  const { status, index } = indexStatus(ctx.root, ctx.layout.indexRelPath);
  const stats = vaultNoteStats(ctx.root, { vaultDirRel: ctx.layout.vaultDirRel });
  const counts = indexedCounts(index);

  const payload = {
    index_status: status,
    notes_count: stats.notesCount,
    indexed_files: counts.files,
    indexed_symbols: counts.symbols,
    total_note_bytes: stats.totalBytes,
    total_note_estimated_tokens: stats.totalTokens,
    largest_notes: stats.largestNotes,
  };

  const human = [
    `index_status: ${status}`,
    `notes: ${stats.notesCount} (${stats.totalBytes} bytes, ${stats.totalTokens} est. tokens)`,
    `indexed: ${counts.files} files / ${counts.symbols} symbols`,
  ].join('\n');

  emitSuccess(ctx, payload, human);
  return 0;
}
