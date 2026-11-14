#!/usr/bin/env node
/**
 * Deterministic, zero-dependency vault CLI stub for the unhealthy fixture.
 *
 * `check` reports one broken link and exits 2; `stats` fails like a missing or
 * stale index (exit 4, no payload). It never writes to disk.
 */
const argv = process.argv.slice(2);
const command = argv[0] ?? '';

if (command === 'check') {
  process.stderr.write(JSON.stringify({ error: { code: 'broken_link', message: 'fixture: 1 broken link in 20-contracts' } }) + '\n');
  process.exitCode = 2;
} else if (command === 'stats') {
  process.exitCode = 4;
} else {
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: 'unsupported stub command: ' + command } }) + '\n');
  process.exitCode = 3;
}