import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';

/** Workspace-relative path of the append-only run log. */
export const HISTORY_FILE = '.dsh/doctor/history.jsonl';

/**
 * Read every recorded run, retaining the line number of each record.
 *
 * @param {object} context Workspace context.
 * @returns {object[]} Records in append order, each carrying `line` and `logPath`.
 */
export function readHistory(context) {
  const text = context.readText(HISTORY_FILE);
  if (!text) return [];
  const records = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      records.push({ ...JSON.parse(line), line: index + 1, logPath: HISTORY_FILE });
    } catch {
      // A truncated final line from a killed run must not hide the earlier records.
    }
  });
  return records;
}

/**
 * Create the history directory if it is absent.
 *
 * Runs that record history create `.dsh`, which checks such as
 * `state.orphaned-lock` inspect. Creating it before the checks execute keeps a
 * recorded run from changing the result of the next one.
 *
 * @param {object} context Workspace context.
 * @returns {void}
 */
export function ensureHistoryDirectory(context) {
  mkdirSync(dirname(context.absolute(HISTORY_FILE)), { recursive: true });
}

/**
 * Append one run record to the history log.
 *
 * @param {object} context Workspace context.
 * @param {object} record Serializable record.
 * @returns {string} Workspace-relative path of the written log.
 */
export function appendHistory(context, record) {
  ensureHistoryDirectory(context);
  appendFileSync(context.absolute(HISTORY_FILE), `${JSON.stringify(record)}\n`, 'utf8');
  return HISTORY_FILE;
}

/**
 * Find every recorded run where a check did not pass.
 *
 * @param {object[]} records Records from {@link readHistory}.
 * @param {string} id Check id.
 * @returns {object[]} Matching occurrences, oldest first.
 */
export function occurrencesOf(records, id) {
  const found = [];
  for (const record of records) {
    for (const finding of record.findings ?? []) {
      if (finding.id !== id) continue;
      if (finding.status === 'pass' || finding.status === 'skip') continue;
      found.push({
        at: record.generatedAt,
        harnessVersion: record.harnessVersion ?? null,
        status: finding.status,
        summary: finding.summary,
        evidence: finding.evidence ?? [],
        logPath: record.logPath,
        line: record.line,
      });
    }
  }
  return found;
}

/**
 * Delete files named by a finding's evidence.
 *
 * @param {object} context Workspace context.
 * @param {string[]} paths Workspace-relative paths to remove.
 * @returns {string[]} Removed paths.
 */
export function removeFiles(context, paths) {
  const removed = [];
  for (const path of paths) {
    const target = context.absolute(path);
    const inside = relative(context.root, target);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) continue;
    rmSync(target, { force: true });
    removed.push(path);
  }
  return removed;
}

/**
 * Append a line to a workspace file, creating it when absent.
 *
 * @param {object} context Workspace context.
 * @param {string} path Workspace-relative file path.
 * @param {string} line Line to append.
 * @returns {void}
 */
export function appendLine(context, path, line) {
  const target = context.absolute(path);
  const existing = context.readText(path) ?? '';
  const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n';
  writeFileSync(target, `${existing}${prefix}${line}\n`, 'utf8');
}
