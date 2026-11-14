#!/usr/bin/env node
/**
 * Deterministic, zero-dependency vault CLI stub for the partial fixtures.
 *
 * `check` succeeds, but `stats` fails like a missing index (exit 4, no payload)
 * so detection falls back to the documented empty stats. It never writes.
 */
const argv = process.argv.slice(2);
const command = argv[0] ?? '';

if (command === 'check') {
  process.stdout.write(JSON.stringify({ data: { ok: true, strict: argv.includes('--strict'), errors: [] } }) + '\n');
  process.exitCode = 0;
} else if (command === 'stats') {
  process.exitCode = 4;
} else {
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: 'unsupported stub command: ' + command } }) + '\n');
  process.exitCode = 3;
}