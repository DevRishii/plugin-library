const LOCK_ROOT = '.dsh';
const SESSION_STORE = '.dsh/sessions';

/**
 * Fail when a lock file under `.dsh` is older than the TTL.
 *
 * @param {object} context Workspace context.
 * @returns {object} Check outcome.
 */
export function orphanedLock(context) {
  if (!context.exists(LOCK_ROOT)) return { skip: 'no .dsh directory to inspect' };
  const locks = [];
  context.walk(LOCK_ROOT, 6, (path, stat) => {
    if (path.endsWith('.lock')) locks.push({ path, stat });
  });
  if (locks.length === 0) {
    return {
      ok: true,
      summary: 'no lock files are held under .dsh',
      evidence: [{ path: LOCK_ROOT, detail: 'no *.lock files found' }],
    };
  }
  const now = context.now.getTime();
  const stale = locks.filter((lock) => now - lock.stat.mtimeMs > context.stateTtlMs);
  if (stale.length === 0) {
    return {
      ok: true,
      summary: `${locks.length} lock files are within the ${Math.round(context.stateTtlMs / 60000)} minute TTL`,
      evidence: locks.map((lock) => ({ path: lock.path })),
    };
  }
  return {
    ok: false,
    summary: `${stale.length} of ${locks.length} lock files are older than the TTL`,
    evidence: stale.map((lock) => ({
      path: lock.path,
      detail: `last modified ${new Date(lock.stat.mtimeMs).toISOString()}`,
    })),
  };
}

/**
 * Report an oversized session store.
 *
 * @param {object} context Workspace context.
 * @returns {object} Check outcome.
 */
export function sessionStoreSize(context) {
  if (!context.exists(SESSION_STORE)) return { skip: 'no session store at .dsh/sessions' };
  let total = 0;
  const largest = [];
  context.walk(SESSION_STORE, 8, (path, stat) => {
    total += stat.size;
    largest.push({ path, size: stat.size });
  });
  largest.sort((left, right) => right.size - left.size);
  const megabytes = total / (1024 * 1024);
  const summary = `.dsh/sessions holds ${megabytes.toFixed(1)} MiB across ${largest.length} files`;
  if (total <= context.sessionStoreBytes) {
    return { ok: true, summary, evidence: [{ path: SESSION_STORE }] };
  }
  return {
    ok: false,
    summary,
    evidence: largest.slice(0, 5).map((file) => ({
      path: file.path,
      detail: `${(file.size / (1024 * 1024)).toFixed(1)} MiB, above the ${(context.sessionStoreBytes / (1024 * 1024)).toFixed(0)} MiB budget`,
    })),
  };
}
