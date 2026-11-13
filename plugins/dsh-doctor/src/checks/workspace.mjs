const IGNORE_STATE_SPELLINGS = ['.dsh', '.dsh/', '/.dsh', '/.dsh/'];

/**
 * Warn when `.dsh` state is not ignored by the workspace `.gitignore`.
 *
 * @param {object} context Workspace context.
 * @returns {object} Check outcome.
 */
export function gitignoreMissingState(context) {
  const text = context.readText('.gitignore');
  if (text === null) return { skip: 'the workspace has no .gitignore' };
  const entries = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  if (entries.some((entry) => IGNORE_STATE_SPELLINGS.includes(entry))) {
    return {
      ok: true,
      summary: '.gitignore ignores .dsh state',
      evidence: [{ path: '.gitignore' }],
    };
  }
  return {
    ok: false,
    summary: '.gitignore does not ignore .dsh state',
    evidence: [{ path: '.gitignore', detail: 'no line ignores .dsh or .dsh/' }],
  };
}

/**
 * Report root files above the size budget.
 *
 * @param {object} context Workspace context.
 * @returns {object} Check outcome.
 */
export function largeFile(context) {
  const oversized = [];
  let inspected = 0;
  for (const entry of context.list('.')) {
    if (entry.dir) continue;
    const metadata = context.stat(entry.name);
    if (!metadata) continue;
    inspected += 1;
    if (metadata.size > context.largeFileBytes) {
      oversized.push({ path: entry.name, size: metadata.size });
    }
  }
  const budget = `${(context.largeFileBytes / (1024 * 1024)).toFixed(0)} MiB`;
  if (oversized.length === 0) {
    return {
      ok: true,
      summary: `no root file exceeds ${budget} (${inspected} inspected)`,
      evidence: [{ path: '.', detail: `${inspected} root files inspected` }],
    };
  }
  return {
    ok: false,
    summary: `${oversized.length} root files exceed ${budget}`,
    evidence: oversized
      .sort((left, right) => right.size - left.size)
      .slice(0, 10)
      .map((file) => ({
        path: file.path,
        detail: `${(file.size / (1024 * 1024)).toFixed(1)} MiB`,
      })),
  };
}
