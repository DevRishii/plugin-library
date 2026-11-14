import { ERROR_CODES, EXIT_CODES, emitFailure, emitSuccess } from '../shared.mjs';
import { validateVault } from '../validate.mjs';

/**
 * @param {string} message
 */
function primaryCode(message) {
  if (/broken_link/.test(message)) return ERROR_CODES.BROKEN_LINK;
  if (/budget_exceeded|token budget|exceeds \d+-token|exceeds 5 bullets/i.test(message)) {
    return ERROR_CODES.BUDGET_EXCEEDED;
  }
  return ERROR_CODES.INVALID_FRONTMATTER;
}

/**
 * Validate schemas, links, budgets, canonical ids and MOC reachability.
 * @param { { root: string, flags: Record<string, string | boolean>, positionals: string[], json: boolean, quiet: boolean } } ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  const strict = ctx.flags.strict === true;
  const result = validateVault(ctx.root, {
    strict,
    vaultDirRel: ctx.layout.vaultDirRel,
    runsRelDir: ctx.layout.defaultRunsRelDir,
  });

  if (result.ok) {
    const mode = strict ? 'strict' : 'default';
    emitSuccess(
      ctx,
      result,
      `vault ok (${mode}): ${result.notes} notes, ${result.warnings.length} warning(s)`,
    );
    return EXIT_CODES.OK;
  }

  const first = result.errors[0] ?? 'validation failed';
  const code = primaryCode(first);
  return emitFailure(
    ctx,
    code,
    `${result.errors.length} validation error(s): ${first}`,
    EXIT_CODES.VALIDATION,
  );
}
