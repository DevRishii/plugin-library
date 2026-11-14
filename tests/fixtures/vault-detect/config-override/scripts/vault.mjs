#!/usr/bin/env node
/**
 * Deterministic, zero-dependency vault CLI stub for vault-detect fixtures.
 *
 * It answers `check` and `stats` exactly like a healthy vault CLI would and
 * never writes to disk, so detection stays provably read-only.
 */
const argv = process.argv.slice(2);
const command = argv[0] ?? '';

if (command === 'check') {
  process.stdout.write(JSON.stringify({ data: { ok: true, strict: argv.includes('--strict'), errors: [] } }) + '\n');
  process.exitCode = 0;
} else if (command === 'stats') {
  process.stdout.write(JSON.stringify({ data: { notes: 6, symbols: 42, index_status: 'fresh' } }) + '\n');
  process.exitCode = 0;
} else {
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: 'unsupported stub command: ' + command } }) + '\n');
  process.exitCode = 3;
}