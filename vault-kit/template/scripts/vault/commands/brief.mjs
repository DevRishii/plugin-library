import {
  BUDGETS,
  ERROR_CODES,
  EXIT_CODES,
  VaultError,
  emitSuccess,
  emitTokenNotice,
} from '../shared.mjs';
import { loadFreshIndex, resolveTaskNote } from '../rank.mjs';
import { buildDigest, fitBriefToBudget } from '../render.mjs';

/**
 * @param {unknown} raw
 * @param {number} fallback
 */
function positiveInt(raw, fallback, flagName) {
  if (raw === undefined) return fallback;
  const text = String(raw).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.BUDGET_EXCEEDED, `invalid ${flagName}: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VaultError(EXIT_CODES.VALIDATION, ERROR_CODES.BUDGET_EXCEEDED, `invalid ${flagName}: ${text}`);
  }
  return value;
}

/**
 * @param { { root: string, flags: Record<string, string | boolean>, positionals: string[], json: boolean, quiet: boolean } } ctx
 */
export async function run(ctx) {
  const taskRaw = ctx.flags.task;
  if (typeof taskRaw !== 'string' || taskRaw.trim() === '') {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.INVALID_FRONTMATTER,
      'missing required flag: --task',
    );
  }
  const task = taskRaw.trim();

  const budget = positiveInt(ctx.flags.budget, BUDGETS.BRIEF_DEFAULT_TOKENS, '--budget');

  const formatRaw = ctx.flags.format;
  if (formatRaw !== undefined && formatRaw !== 'md' && formatRaw !== 'json') {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.INVALID_FRONTMATTER,
      `invalid --format: ${String(formatRaw)} (expected md|json)`,
    );
  }
  const asJson = ctx.json || formatRaw === 'json';

  const index = loadFreshIndex(ctx);
  const note = resolveTaskNote(index, task);
  if (!note) {
    throw new VaultError(EXIT_CODES.NOT_FOUND, ERROR_CODES.NOT_FOUND, `unknown task: ${task}`);
  }

  const digest = buildDigest(index, note);
  const fitted = fitBriefToBudget(digest, budget);
  const finalDigest = fitted.digest;

  emitTokenNotice(ctx, fitted.tokens);

  const payload = {
    id: finalDigest.id,
    goal: finalDigest.goal,
    status: finalDigest.status,
    owner: finalDigest.owner,
    tokens: fitted.tokens,
    budget,
    truncated: fitted.truncated,
    read_first: finalDigest.read_first,
    owned_paths: finalDigest.owned_paths,
    read_only_contracts: finalDigest.read_only_contracts,
    acceptance: finalDigest.acceptance,
    open_decisions: finalDigest.open_decisions,
    markdown: fitted.markdown,
  };

  emitSuccess({ json: asJson, quiet: ctx.quiet }, payload, fitted.markdown);
  return EXIT_CODES.OK;
}
