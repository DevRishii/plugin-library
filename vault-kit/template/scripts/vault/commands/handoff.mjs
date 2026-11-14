import { ERROR_CODES, EXIT_CODES, VaultError } from '../shared.mjs';
import { listHandoffs, writeHandoff } from '../handoff.mjs';

/**
 * Dispatch `handoff write` / `handoff list`.
 * @param { { root: string, flags: Record<string, string | boolean>, positionals: string[], json: boolean, quiet: boolean } } ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  const subcommand = ctx.positionals[0];

  if (subcommand === 'write') {
    return writeHandoff(ctx);
  }
  if (subcommand === 'list') {
    return listHandoffs(ctx);
  }
  if (!subcommand) {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.INVALID_FRONTMATTER,
      'missing handoff subcommand (expected write or list)',
    );
  }
  throw new VaultError(
    EXIT_CODES.VALIDATION,
    ERROR_CODES.NOT_FOUND,
    `unknown handoff subcommand: ${subcommand}`,
  );
}
