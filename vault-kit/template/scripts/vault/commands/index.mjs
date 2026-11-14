/**
 * `vault index` command: write or verify the context index.
 */

import { checkContextIndex, writeContextIndex } from '../indexer.mjs';
import { emitSuccess } from '../shared.mjs';

/**
 * @param { { root: string, flags: Record<string, string | boolean>, json: boolean, quiet: boolean } } ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  if (ctx.flags.check === true) {
    const index = checkContextIndex(ctx.root, ctx.layout);
    emitSuccess(
      ctx,
      {
        status: 'fresh',
        source_hash: index.source_hash,
        stats: index.stats,
      },
      `context index is fresh (${index.stats.files} files, ${index.stats.notes} notes, ${index.stats.symbols} symbols)`,
    );
    return 0;
  }

  const index = writeContextIndex(ctx.root, ctx.layout);
  emitSuccess(
    ctx,
    {
      path: ctx.layout.indexRelPath,
      source_hash: index.source_hash,
      stats: index.stats,
    },
    `wrote ${ctx.layout.indexRelPath} (${index.stats.files} files, ${index.stats.notes} notes, ${index.stats.symbols} symbols)`,
  );
  return 0;
}
