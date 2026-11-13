/** Session-log path helper shared by the CLI tests. */
import { join } from 'node:path'
import { workspaceSlug } from '../src/session.mjs'

/**
 * The session log path for a fake home.
 * @param {string} home - fake home directory.
 * @param {string} cwd - session working directory.
 * @param {string} id - session id.
 * @returns {string} the `session.v4.jsonl.zstd` path.
 */
export function sessionFile(home, cwd, id) {
  return join(home, '.dsh', 'sessions', workspaceSlug(cwd), id, 'session.v4.jsonl.zstd')
}
