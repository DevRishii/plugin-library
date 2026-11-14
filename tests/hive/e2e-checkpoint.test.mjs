#!/usr/bin/env node
/**
 * Executable end-to-end checkpoint tests.
 *
 * These drive the real lifecycle CLI against a copied fixture repository:
 * detect `absent` -> exact create question -> `No` leaves everything untouched
 * -> scaffold/record/update on the accept path. They also pin the `question`
 * tool boundary (`questions: [item]`, DECISIONS D3) and the plan-before-write
 * ordering documented by the checkpoint prompt.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { QUESTION_FLOW_A, QUESTION_FLOW_B } from '../../scripts/hive/contracts.mjs';
import {
  REPO_ROOT,
  createFreshRepo,
  dataOf,
  readRepoFile,
  runLifecycle,
  snapshotTree,
  toQuestionToolPayload,
} from '../../scripts/hive/e2e-fixtures.mjs';

test('fresh repo: detect absent, exact create question, and No writes no vault or app files', (t) => {
  const root = createFreshRepo(t, 'deny');
  const before = snapshotTree(root);

  const detected = dataOf(runLifecycle(root, ['detect']));
  assert.equal(detected.state, 'absent');
  assert.equal(detected.vault_dir, '.opencode/vault');
  assert.deepEqual(detected.missing, [
    '.opencode/vault/00-MOC.md',
    'scripts/vault.mjs',
  ]);

  const planned = dataOf(runLifecycle(root, ['plan', '--goal', 'goal-deny']));
  assert.equal(planned.action, 'prompt_create');
  assert.equal(planned.flow, 'create');
  assert.equal(planned.state, 'absent');
  assert.equal(planned.answered, false);
  assert.equal(planned.reason, 'unanswered');
  assert.deepEqual(planned.question, QUESTION_FLOW_A);
  assert.deepEqual(
    planned.question.options.map((option) => option.label),
    ['Yes', 'No'],
  );
  assert.deepEqual(toQuestionToolPayload(planned.question), {
    questions: [QUESTION_FLOW_A],
  });

  // `detect` and `plan` are pure: no state, vault, or source mutation.
  assert.deepEqual(snapshotTree(root), before);

  const recorded = dataOf(
    runLifecycle(root, ['state', 'record', '--goal', 'goal-deny', '--choice', 'no']),
  );
  assert.equal(recorded.answered, true);
  assert.equal(recorded.record.choice, 'no');
  assert.equal(recorded.record.prompt, null);

  // The only write is `.hive/` state; application and vault paths are unchanged.
  assert.deepEqual(snapshotTree(root, { exclude: ['.hive'] }), before);
  assert.equal(existsSync(join(root, '.opencode')), false);
  assert.equal(existsSync(join(root, 'scripts', 'vault.mjs')), false);

  const suppressed = dataOf(runLifecycle(root, ['plan', '--goal', 'goal-deny']));
  assert.equal(suppressed.action, 'none');
  assert.equal(suppressed.reason, 'already_answered');
  assert.equal(suppressed.question, null);
  assert.equal(suppressed.record.choice, 'no');
  assert.deepEqual(snapshotTree(root, { exclude: ['.hive'] }), before);
});

test('accept path: Yes scaffolds, record yes suppresses the prompt, changed source updates healthy', (t) => {
  const root = createFreshRepo(t, 'accept');
  const sourceBefore = snapshotTree(join(root, 'src'));

  const planned = dataOf(runLifecycle(root, ['plan', '--goal', 'goal-build']));
  assert.equal(planned.action, 'prompt_create');
  assert.deepEqual(planned.question, QUESTION_FLOW_A);

  const scaffolded = dataOf(runLifecycle(root, ['scaffold', '--yes']));
  assert.equal(scaffolded.ok, true);
  assert.equal(scaffolded.index_exit, 0);
  assert.equal(scaffolded.check_exit, 0);
  assert.equal(scaffolded.state, 'present_healthy');
  for (const rel of [
    '.opencode/vault/00-MOC.md',
    '.opencode/vault/10-map/map-repo.md',
    '.opencode/vault/10-map/map-layers.md',
    'scripts/vault.mjs',
  ]) {
    assert.ok(existsSync(join(root, rel)), `scaffold must create ${rel}`);
  }
  // Application source is never rewritten by scaffolding.
  assert.deepEqual(snapshotTree(join(root, 'src')), sourceBefore);

  const agents = readRepoFile(root, 'AGENTS.md');
  assert.match(agents, /Keep this prose/);
  assert.match(agents, /<!-- context-vault:begin -->/);
  assert.match(agents, /<!-- context-vault:end -->/);
  assert.match(readRepoFile(root, '.gitignore'), /^\.hive\/$/m);

  const recordedCreate = dataOf(
    runLifecycle(root, [
      'state',
      'record',
      '--goal',
      'goal-build',
      '--prompt',
      'create',
      '--choice',
      'yes',
      '--scaffold-exit',
      '0',
      '--index-exit',
      String(scaffolded.index_exit),
      '--check-exit',
      String(scaffolded.check_exit),
    ]),
  );
  assert.equal(recordedCreate.record.choice, 'yes');
  assert.equal(recordedCreate.record.prompt, 'create');

  const suppressedCreate = dataOf(runLifecycle(root, ['plan', '--goal', 'goal-build']));
  assert.equal(suppressedCreate.action, 'none');
  assert.equal(suppressedCreate.reason, 'already_answered');
  assert.equal(suppressedCreate.record.prompt, 'create');
  assert.equal(suppressedCreate.question, null);

  // Change and add source files so the index drifts from the vault.
  writeFileSync(
    join(root, 'src', 'index.mjs'),
    'export function greet() {\n  return "changed";\n}\n',
  );
  writeFileSync(join(root, 'src', 'extra.mjs'), 'export const extra = 7;\n');
  const sourceAfterChange = snapshotTree(join(root, 'src'));

  const drift = dataOf(runLifecycle(root, ['detect']));
  assert.ok(
    ['present_healthy', 'present_unhealthy'].includes(drift.state),
    `expected an existing vault after drift, received ${drift.state}`,
  );

  const updatePlan = dataOf(runLifecycle(root, ['plan', '--goal', 'goal-refresh']));
  assert.equal(updatePlan.action, 'prompt_update');
  assert.equal(updatePlan.flow, 'update');
  assert.equal(updatePlan.answered, false);
  assert.deepEqual(updatePlan.question, QUESTION_FLOW_B);
  assert.deepEqual(toQuestionToolPayload(updatePlan.question), {
    questions: [QUESTION_FLOW_B],
  });

  const updated = dataOf(
    runLifecycle(root, ['update', '--yes', '--goal', 'goal-refresh']),
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.index_exit, 0);
  assert.equal(updated.check_exit, 0);
  assert.equal(updated.state, 'present_healthy');
  assert.ok(
    updated.created.includes('.opencode/vault/20-contracts/contract-src-extra.md'),
    `update must derive a contract for the new source, received ${updated.created.join(', ')}`,
  );
  assert.deepEqual(snapshotTree(join(root, 'src')), sourceAfterChange);
  assert.equal(
    readFileSync(join(root, 'src', 'index.mjs'), 'utf8'),
    'export function greet() {\n  return "changed";\n}\n',
  );

  const healthy = dataOf(runLifecycle(root, ['detect']));
  assert.equal(healthy.state, 'present_healthy');

  const recordedUpdate = dataOf(
    runLifecycle(root, [
      'state',
      'record',
      '--goal',
      'goal-refresh',
      '--prompt',
      'update',
      '--choice',
      'yes',
      '--index-exit',
      String(updated.index_exit),
      '--check-exit',
      String(updated.check_exit),
    ]),
  );
  assert.equal(recordedUpdate.record.choice, 'yes');
  assert.equal(recordedUpdate.record.prompt, 'update');

  const suppressedUpdate = dataOf(runLifecycle(root, ['plan', '--goal', 'goal-refresh']));
  assert.equal(suppressedUpdate.action, 'none');
  assert.equal(suppressedUpdate.reason, 'already_answered');
  assert.equal(suppressedUpdate.record.choice, 'yes');
  assert.equal(suppressedUpdate.question, null);
});

test('CI auto-selects No without prompting or writing state or a vault', (t) => {
  const root = createFreshRepo(t, 'ci');
  const before = snapshotTree(root);

  const planned = dataOf(
    runLifecycle(root, ['plan', '--goal', 'goal-ci'], { env: { CI: '1' } }),
  );
  assert.equal(planned.action, 'none');
  assert.equal(planned.ci_auto_no, true);
  assert.equal(planned.reason, 'ci_auto_no');
  assert.equal(planned.question, null);

  assert.deepEqual(snapshotTree(root), before);
  assert.equal(existsSync(join(root, '.hive')), false);
});

test('checkpoint contract wraps the plan item in questions[] and orders plan before writes', () => {
  const prompt = readRepoFile(REPO_ROOT, 'vault-kit/prompts/post-goal-checkpoint.md');
  const decisions = readRepoFile(REPO_ROOT, 'docs/context-vault/DECISIONS.md');

  const planAt = prompt.indexOf('vault-lifecycle.mjs plan');
  const questionAt = prompt.indexOf('Call the `question` tool');
  const scaffoldAt = prompt.indexOf('vault-lifecycle.mjs scaffold --yes');
  const updateAt = prompt.indexOf('vault-lifecycle.mjs update --yes --goal');
  const recordNoAt = prompt.indexOf('state record --goal <goal_id> --choice no');

  assert.ok(planAt >= 0, 'checkpoint prompt must run plan');
  assert.ok(questionAt > planAt, 'question must follow the plan action');
  assert.ok(scaffoldAt > questionAt, 'scaffold must only run after consent');
  assert.ok(updateAt > questionAt, 'update must only run after consent');
  assert.ok(recordNoAt > questionAt, 'No must be recorded after the question');

  assert.match(
    decisions,
    /questions:\s*\[\{\s*header, question, options/,
    'DECISIONS D3 must record the tool-boundary wrapper',
  );
  assert.deepEqual(Object.keys(toQuestionToolPayload(QUESTION_FLOW_A)), ['questions']);
  assert.deepEqual(toQuestionToolPayload(QUESTION_FLOW_A), {
    questions: [QUESTION_FLOW_A],
  });
});
