import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildQuestionObject,
  buildPromptPlan,
  buildVaultPrompt,
} from '../../scripts/hive/vault-prompt.mjs';
import {
  QUESTION_FLOW_A,
  QUESTION_FLOW_B,
  EXIT_CODES,
  ERROR_CODES,
  HiveContractError,
} from '../../scripts/hive/contracts.mjs';

const CLI = fileURLToPath(new URL('../../scripts/hive/vault-prompt.mjs', import.meta.url));
const FIXTURE_DIR = new URL('../fixtures/vault-prompt/', import.meta.url);

/** @param {string} name */
function golden(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), 'utf8'));
}

/**
 * Run the CLI with CI explicitly off unless a test overrides it.
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [env]
 */
function invoke(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CI: '', ...env },
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

/** @param {ReturnType<typeof invoke>} result */
function dataOf(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).data;
}

test('create --json emits the exact Flow A question and plan envelope', () => {
  const data = dataOf(invoke(['create', '--json']));
  assert.deepEqual(data.question, golden('flow-a.json'));
  assert.deepEqual(data.question, QUESTION_FLOW_A);
  assert.equal(data.flow, 'create');
  assert.equal(data.state, 'absent');
  assert.equal(data.ci_auto_no, false);
  assert.equal(data.choice, null);
  assert.deepEqual(Object.keys(data).sort(), ['choice', 'ci_auto_no', 'flow', 'question', 'state']);
  assert.deepEqual(Object.keys(data.question).sort(), ['header', 'options', 'question']);
});

test('update --json emits the exact Flow B question and plan envelope', () => {
  const data = dataOf(invoke(['update', '--json']));
  assert.deepEqual(data.question, golden('flow-b.json'));
  assert.deepEqual(data.question, QUESTION_FLOW_B);
  assert.equal(data.flow, 'update');
  assert.equal(data.state, 'present_healthy');
  assert.equal(data.ci_auto_no, false);
  assert.equal(data.choice, null);
});

test('create --state partial prepends the repair notice and uses the default vault dir', () => {
  const data = dataOf(
    invoke([
      'create',
      '--state',
      'partial',
      '--missing',
      '.opencode/vault/00-MOC.md,scripts/vault.mjs',
      '--json',
    ]),
  );
  assert.equal(data.flow, 'create');
  assert.equal(data.state, 'partial');
  assert.deepEqual(data.question, golden('flow-a-partial.json'));
  assert.equal(
    data.question.question,
    'A partial vault was found at .opencode/vault (missing: .opencode/vault/00-MOC.md, scripts/vault.mjs). It will be repaired, not overwritten. ' +
      QUESTION_FLOW_A.question,
  );
  assert.ok(data.question.question.startsWith('A partial vault was found at .opencode/vault'));
  assert.equal(data.question.header, QUESTION_FLOW_A.header);
  assert.deepEqual(data.question.options, QUESTION_FLOW_A.options);
});

test('CI auto-selects No for both flows without emitting a question', () => {
  for (const args of [['create', '--json'], ['update', '--json'], ['update', '--state', 'present_unhealthy', '--json']]) {
    const data = dataOf(invoke(args, { CI: '1' }));
    assert.equal(data.ci_auto_no, true);
    assert.equal(data.choice, 'no');
    assert.equal(data.question, null);
  }
  for (const value of ['true', 'yes', '1']) {
    const data = dataOf(invoke(['create', '--json'], { CI: value }));
    assert.equal(data.choice, 'no');
  }
});

test('unknown subcommands and mismatched --state values exit 2 with refused', () => {
  for (const args of [
    ['bogus', '--json'],
    ['--json'],
    ['create', 'extra', '--json'],
    ['create', '--state', 'present_healthy', '--json'],
    ['create', '--state', 'present_unhealthy', '--json'],
    ['update', '--state', 'absent', '--json'],
    ['update', '--state', 'partial', '--json'],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, EXIT_CODES.VALIDATION, `args: ${args.join(' ')}`);
    const body = JSON.parse(result.stderr);
    assert.equal(body.error.code, ERROR_CODES.REFUSED);
    assert.equal(result.stdout, '');
  }
});

test('question options keep the Yes/No contract with no extra keys', () => {
  for (const flow of ['create', 'update']) {
    const question = buildQuestionObject({ flow });
    assert.ok(question.header.length <= 30, `${question.header} too long`);
    assert.deepEqual(
      question.options.map((option) => option.label),
      ['Yes', 'No'],
    );
    for (const option of question.options) {
      assert.deepEqual(Object.keys(option).sort(), ['description', 'label']);
      assert.equal(typeof option.description, 'string');
      assert.ok(option.description.length > 0);
    }
  }
});

test('buildQuestionObject is pure and clones the frozen contract objects', () => {
  const first = buildQuestionObject({ flow: 'create', state: 'absent' });
  first.options[0].label = 'Mutated';
  first.header = 'Mutated';
  const second = buildQuestionObject({ flow: 'create', state: 'absent' });
  assert.deepEqual(second, QUESTION_FLOW_A);
  assert.equal(second.options[0].label, 'Yes');
  assert.equal(second.header, QUESTION_FLOW_A.header);
});

test('buildQuestionObject normalizes a custom vault dir and missing paths', () => {
  const question = buildQuestionObject({
    flow: 'create',
    state: 'partial',
    vaultDir: 'docs\\vault\\',
    missing: ['scripts\\vault.mjs', '  ', '.opencode\\vault\\00-MOC.md'],
  });
  assert.ok(
    question.question.startsWith(
      'A partial vault was found at docs/vault (missing: scripts/vault.mjs, .opencode/vault/00-MOC.md). It will be repaired, not overwritten. ',
    ),
  );
  const unknown = buildQuestionObject({ flow: 'create', state: 'partial', missing: [] });
  assert.ok(unknown.question.includes('(missing: unknown).'));
});

test('buildPromptPlan and buildVaultPrompt share the CLI plan shape', () => {
  const off = buildPromptPlan({ flow: 'create', state: 'absent', env: { CI: '' } });
  assert.deepEqual(off, {
    flow: 'create',
    state: 'absent',
    ci_auto_no: false,
    choice: null,
    question: QUESTION_FLOW_A,
  });
  assert.deepEqual(buildVaultPrompt({ flow: 'update', env: { CI: '0' } }), {
    flow: 'update',
    state: 'present_healthy',
    ci_auto_no: false,
    choice: null,
    question: QUESTION_FLOW_B,
  });
  assert.deepEqual(buildPromptPlan({ flow: 'update', env: { CI: '1' } }), {
    flow: 'update',
    state: 'present_healthy',
    ci_auto_no: true,
    choice: 'no',
    question: null,
  });
});

test('programmatic validation throws HiveContractError with exit code 2', () => {
  for (const options of [
    { flow: 'bogus' },
    { flow: 'create', state: 'present_healthy' },
    { flow: 'update', state: 'absent' },
    { flow: 'create', vaultDir: '..' },
  ]) {
    assert.throws(
      () => buildQuestionObject(options),
      (error) => error instanceof HiveContractError && error.exitCode === EXIT_CODES.VALIDATION,
      JSON.stringify(options),
    );
  }
});

test('--quiet suppresses human output but --json still emits it', () => {
  const quiet = invoke(['create', '--quiet']);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, '');

  const jsonQuiet = invoke(['create', '--json', '--quiet']);
  assert.equal(jsonQuiet.status, 0, jsonQuiet.stderr);
  assert.deepEqual(JSON.parse(jsonQuiet.stdout).data.question, QUESTION_FLOW_A);
});