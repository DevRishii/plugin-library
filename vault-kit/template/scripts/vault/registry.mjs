import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ERROR_CODES, EXIT_CODES, emitFailure } from './shared.mjs';

export const COMMAND_NAMES = Object.freeze([
  'index',
  'brief',
  'find',
  'slice',
  'handoff',
  'check',
  'stats',
]);

export const COMMAND_DESCRIPTIONS = Object.freeze({
  index: 'Scan repo + vault notes and write .opencode/vault/.index/context-index.json',
  brief: 'Emit a bounded task digest (<= 1200 est. tokens) for a slice or path',
  find: 'Search indexed notes and symbols without scanning raw files',
  slice: 'Extract a bounded symbol or header slice from a source file',
  handoff: 'Write or list structured run handoff digests under 90-handoffs/<run-id>/',
  check: 'Validate vault schemas, frontmatter, links, MOC reachability, and budgets',
  stats: 'Report index freshness, counts, and largest vault notes',
});

/**
 * Dispatch a vault subcommand via lazy ESM import.
 *
 * - Unknown command -> exit 2 (`not_found`)
 * - Missing command module file (pre-Wave-1) -> exit 1 (`internal`) with one-line message
 *
 * @param {string} commandName
 * @param { { root: string, flags: Record<string, string | boolean>, positionals: string[], json: boolean, quiet: boolean } } ctx
 * @returns {Promise<number>}
 */
export async function dispatchCommand(commandName, ctx) {
  if (!COMMAND_NAMES.includes(commandName)) {
    return emitFailure(
      ctx,
      ERROR_CODES.NOT_FOUND,
      `unknown command: ${commandName}`,
      EXIT_CODES.VALIDATION,
    );
  }

  const modulePath = join(import.meta.dirname, 'commands', `${commandName}.mjs`);
  if (!existsSync(modulePath)) {
    return emitFailure(
      ctx,
      ERROR_CODES.INTERNAL,
      `command module not implemented: ${commandName}`,
      EXIT_CODES.INTERNAL,
    );
  }

  const mod = await import(pathToFileURL(modulePath).href);
  if (typeof mod.run !== 'function') {
    return emitFailure(
      ctx,
      ERROR_CODES.INTERNAL,
      `command module invalid (missing run export): ${commandName}`,
      EXIT_CODES.INTERNAL,
    );
  }

  const code = await mod.run(ctx);
  return typeof code === 'number' ? code : EXIT_CODES.OK;
}
