#!/usr/bin/env node
/**
 * Exact `question` tool payload builder for the Hivemind context-vault prompts.
 *
 * Flow A (`create`) covers a repository with no vault (`absent`) and a partial
 * vault (`partial`, repaired not overwritten). Flow B (`update`) covers an
 * existing vault that needs refreshed pointers (`present_healthy` and
 * `present_unhealthy` share the same refresh question).
 *
 * Zero external dependencies; pure, deterministic, no I/O.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  QUESTION_FLOW_A,
  QUESTION_FLOW_B,
  VAULT_STATES,
  DEFAULT_VAULT_DIR,
  EXIT_CODES,
  ERROR_CODES,
  HiveContractError,
  parseCliArgs,
  emitSuccess,
  emitFailure,
  isCiEnvironment,
  toPosixPath,
} from './contracts.mjs';

const MAX_HEADER_LENGTH = 30;

const FLOW_STATES = Object.freeze({
  create: Object.freeze([VAULT_STATES.ABSENT, VAULT_STATES.PARTIAL]),
  update: Object.freeze([VAULT_STATES.PRESENT_HEALTHY, VAULT_STATES.PRESENT_UNHEALTHY]),
});

const DEFAULT_FLOW_STATE = Object.freeze({
  create: VAULT_STATES.ABSENT,
  update: VAULT_STATES.PRESENT_HEALTHY,
});

/**
 * @param {string} message
 * @returns {never}
 */
function refuse(message) {
  throw new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, message);
}

/**
 * @param {unknown} flow
 * @returns {string}
 */
function normalizeFlow(flow) {
  const value = String(flow ?? '').trim().toLowerCase();
  if (value !== 'create' && value !== 'update') {
    refuse(`unknown subcommand: ${value || '<empty>'} (expected create or update)`);
  }
  return value;
}

/**
 * @param {string} flow
 * @param {unknown} state
 * @returns {string}
 */
function normalizeState(flow, state) {
  const allowed = FLOW_STATES[flow];
  const fallback = DEFAULT_FLOW_STATE[flow];
  if (state === undefined || state === null || state === '') return fallback;
  if (typeof state !== 'string') refuse(`invalid --state: ${String(state)}`);
  const value = state.trim().toLowerCase();
  if (!allowed.includes(value)) {
    refuse(`invalid --state for ${flow}: ${value || '<empty>'} (expected ${allowed.join(' or ')})`);
  }
  return value;
}

/**
 * @param {unknown} vaultDir
 * @returns {string}
 */
function normalizeVaultDir(vaultDir) {
  if (vaultDir === undefined || vaultDir === null || vaultDir === '') return DEFAULT_VAULT_DIR;
  if (typeof vaultDir !== 'string') refuse(`invalid --vault-dir: ${String(vaultDir)}`);
  const raw = vaultDir.trim();
  if (raw.includes('\0')) refuse('invalid null byte in --vault-dir');
  const posix = toPosixPath(raw);
  if (posix === '.' || posix === '..' || posix.startsWith('../') || posix.includes('/../') || posix.endsWith('/..')) {
    refuse(`invalid --vault-dir: ${raw}`);
  }
  return posix;
}

/**
 * Normalize the `--missing` list into stable, comma-plus-space text.
 * Empty or absent lists become `unknown`.
 * @param {unknown} missing
 * @returns {string}
 */
function normalizeMissingList(missing) {
  /** @type {unknown[]} */
  let entries;
  if (missing === undefined || missing === null) entries = [];
  else if (Array.isArray(missing)) entries = missing;
  else if (typeof missing === 'string') entries = missing.split(',');
  else refuse(`invalid --missing: ${String(missing)}`);

  const normalized = [];
  for (const entry of entries) {
    if (entry === undefined || entry === null) continue;
    const raw = String(entry).trim();
    if (!raw) continue;
    if (raw.includes('\0')) refuse('invalid null byte in --missing');
    const posix = toPosixPath(raw);
    if (posix === '.') continue;
    normalized.push(posix);
  }
  return normalized.length > 0 ? normalized.join(', ') : 'unknown';
}

/**
 * @param {string} header
 * @returns {string}
 */
function assertHeader(header) {
  if (header.length > MAX_HEADER_LENGTH) {
    throw new HiveContractError(
      EXIT_CODES.INTERNAL,
      ERROR_CODES.INTERNAL,
      `question header exceeds ${MAX_HEADER_LENGTH} characters: ${header}`,
    );
  }
  return header;
}

/**
 * @param {{ label: string, description: string }[]} options
 * @returns {{ label: string, description: string }[]}
 */
function cloneOptions(options) {
  return options.map((option) => ({ label: option.label, description: option.description }));
}

/**
 * Build the exact `question` tool object for one flow/state.
 *
 * @param {{
 *   flow: 'create' | 'update',
 *   state?: string,
 *   vaultDir?: string,
 *   missing?: string | string[],
 * }} options
 * @returns {{ header: string, question: string, options: { label: string, description: string }[] }}
 */
export function buildQuestionObject(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    refuse('options must be an object');
  }
  const flow = normalizeFlow(options.flow);
  const state = normalizeState(flow, options.state);
  const vaultDir = normalizeVaultDir(options.vaultDir);

  if (flow === 'create') {
    const header = assertHeader(QUESTION_FLOW_A.header);
    if (state === VAULT_STATES.ABSENT) {
      return {
        header,
        question: QUESTION_FLOW_A.question,
        options: cloneOptions(QUESTION_FLOW_A.options),
      };
    }
    const missing = normalizeMissingList(options.missing);
    const prefix = `A partial vault was found at ${vaultDir} (missing: ${missing}). It will be repaired, not overwritten. `;
    return {
      header,
      question: `${prefix}${QUESTION_FLOW_A.question}`,
      options: cloneOptions(QUESTION_FLOW_A.options),
    };
  }

  return {
    header: assertHeader(QUESTION_FLOW_B.header),
    question: QUESTION_FLOW_B.question,
    options: cloneOptions(QUESTION_FLOW_B.options),
  };
}

/**
 * Resolve the prompt plan, honoring the CI auto-`No` rule.
 *
 * @param {{
 *   flow: 'create' | 'update',
 *   state?: string,
 *   vaultDir?: string,
 *   missing?: string | string[],
 *   env?: Record<string, string | undefined>,
 * }} options
 * @returns {{
 *   flow: string,
 *   state: string,
 *   ci_auto_no: boolean,
 *   choice: 'no' | null,
 *   question: { header: string, question: string, options: { label: string, description: string }[] } | null,
 * }}
 */
export function buildPromptPlan(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    refuse('options must be an object');
  }
  const flow = normalizeFlow(options.flow);
  const state = normalizeState(flow, options.state);
  const env = options.env ?? process.env;

  if (isCiEnvironment(env)) {
    return { flow, state, ci_auto_no: true, choice: 'no', question: null };
  }

  return {
    flow,
    state,
    ci_auto_no: false,
    choice: null,
    question: buildQuestionObject({
      flow,
      state,
      vaultDir: options.vaultDir,
      missing: options.missing,
    }),
  };
}

/**
 * Pure programmatic builder. Alias of {@link buildPromptPlan} so callers can
 * use one name whether they want the plan or the question payload.
 *
 * @param {Parameters<typeof buildPromptPlan>[0]} options
 * @returns {ReturnType<typeof buildPromptPlan>}
 */
export function buildVaultPrompt(options) {
  return buildPromptPlan(options);
}

/**
 * @param {ReturnType<typeof buildPromptPlan>} plan
 * @returns {string}
 */
function humanText(plan) {
  if (!plan.question) {
    return `${plan.flow}: ${plan.state} - CI detected, auto-selected No.\n`;
  }
  const lines = [`[${plan.question.header}]`, plan.question.question, ''];
  for (const option of plan.question.options) {
    lines.push(`  ${option.label} - ${option.description}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * CLI entry point. Returns an exit code and never calls `process.exit` itself.
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined> }} [runtime]
 * @returns {number}
 */
export function runCli(argv, runtime = {}) {
  const preJson = Array.isArray(argv) && argv.includes('--json');
  const preQuiet = Array.isArray(argv) && (argv.includes('--quiet') || argv.includes('-q'));
  let ctx = { json: preJson, quiet: preQuiet };
  const env = runtime.env ?? process.env;

  try {
    const { flags, positionals } = parseCliArgs(argv);
    ctx = { json: Boolean(flags.json), quiet: Boolean(flags.quiet) };
    if (flags.help) {
      emitSuccess(
        { ...ctx, json: false },
        {
          usage: [
            'create [--state absent|partial] [--vault-dir <rel>] [--missing <a,b>] [--json] [--quiet]',
            'update [--state present_healthy|present_unhealthy] [--json] [--quiet]',
          ],
        },
        'usage:\n  node scripts/hive/vault-prompt.mjs create [--state absent|partial] [--vault-dir <rel>] [--missing <a,b>] [--json] [--quiet]\n  node scripts/hive/vault-prompt.mjs update [--state present_healthy|present_unhealthy] [--json] [--quiet]\n',
      );
      return EXIT_CODES.OK;
    }

    const command = positionals[0];
    if (command === undefined) refuse('missing subcommand (expected create or update)');
    if (positionals.length > 1) refuse(`unexpected argument: ${positionals[1]}`);
    if (command !== 'create' && command !== 'update') {
      refuse(`unknown subcommand: ${command} (expected create or update)`);
    }

    if (command === 'create' && flags['vault-dir'] === true) {
      refuse('--vault-dir requires a path value');
    }
    if (flags.state === true) refuse('--state requires a value');
    if (flags.missing === true) refuse('--missing requires a value');

    const plan = buildPromptPlan({
      flow: command,
      state: flags.state,
      vaultDir: flags['vault-dir'],
      missing: flags.missing,
      env,
    });

    emitSuccess(ctx, plan, humanText(plan));
    return EXIT_CODES.OK;
  } catch (error) {
    if (error instanceof HiveContractError) {
      return emitFailure(ctx, error.code, error.message, error.exitCode);
    }
    return emitFailure(
      ctx,
      ERROR_CODES.INTERNAL,
      error instanceof Error ? error.message : String(error),
      EXIT_CODES.INTERNAL,
    );
  }
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2));
}