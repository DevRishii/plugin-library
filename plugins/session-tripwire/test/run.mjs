/**
 * In-process test entrypoint.
 *
 * `node --test` spawns one child per file; some confined environments deny that
 * spawn. Importing the suites keeps the same `node:test` harness in one process.
 */

import './ledger.test.mjs'
import './plugin.test.mjs'
