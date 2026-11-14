#!/usr/bin/env node
import { resolve } from 'node:path';
import { COMMAND_DESCRIPTIONS, COMMAND_NAMES, dispatchCommand } from './vault/registry.mjs';
import {
  ERROR_CODES,
  EXIT_CODES,
  VaultError,
  emitFailure,
  parseCliArgs,
  resolveRootDir,
  resolveVaultLayout,
} from './vault/shared.mjs';

const DEFAULT_REPO_ROOT = resolve(import.meta.dirname, '..');

function renderHelp() {
  const cmdLines = COMMAND_NAMES.map(
    (name) => `  ${name.padEnd(10)}${COMMAND_DESCRIPTIONS[name]}`,
  ).join('\n');

  return [
    'Context Vault CLI (zero-dependency progressive disclosure)',
    '',
    'Usage:',
    '  node scripts/vault.mjs <command> [options]',
    '',
    'Commands:',
    cmdLines,
    '',
    'Global options:',
    '  --root <dir>    Vault/repository root directory (default: repo root)',
    '  --json          Emit structured JSON ({ "data": ... } / { "error": ... })',
    '  --quiet         Suppress stderr token notices',
    '  --help          Show usage help',
  ].join('\n');
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof VaultError) {
      return emitFailure({ json: argv.includes('--json') }, err.code, err.message, err.exitCode);
    }
    return emitFailure({ json: argv.includes('--json') }, ERROR_CODES.INTERNAL, String(err), EXIT_CODES.INTERNAL);
  }

  const { flags, positionals } = parsed;
  const json = flags.json === true;
  const quiet = flags.quiet === true;
  const commandName = positionals[0];

  if (flags.help === true && !commandName) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ data: { commands: [...COMMAND_NAMES], usage: 'node scripts/vault.mjs <command> [options]' } })}\n`,
      );
    } else {
      process.stdout.write(`${renderHelp()}\n`);
    }
    return EXIT_CODES.OK;
  }

  if (!commandName) {
    return emitFailure(
      { json },
      ERROR_CODES.NOT_FOUND,
      'missing command (run with --help for usage)',
      EXIT_CODES.VALIDATION,
    );
  }

  let root;
  let layout;
  try {
    const rootArg = typeof flags.root === 'string' ? flags.root : DEFAULT_REPO_ROOT;
    root = resolveRootDir(rootArg);
    layout = resolveVaultLayout(root, flags);
  } catch (err) {
    if (err instanceof VaultError) {
      return emitFailure({ json }, err.code, err.message, err.exitCode);
    }
    return emitFailure({ json }, ERROR_CODES.INTERNAL, String(err), EXIT_CODES.INTERNAL);
  }

  if (flags.help === true) {
    process.stdout.write(`${renderHelp()}\n`);
    return EXIT_CODES.OK;
  }

  try {
    return await dispatchCommand(commandName, {
      root,
      layout,
      flags,
      positionals: positionals.slice(1),
      json,
      quiet,
    });
  } catch (err) {
    if (err instanceof VaultError) {
      return emitFailure({ json }, err.code, err.message, err.exitCode);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return emitFailure({ json }, ERROR_CODES.INTERNAL, msg, EXIT_CODES.INTERNAL);
  }
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
