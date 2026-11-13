import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { countChanges, diffFindings, renderChanges } from '../src/changes.mjs';
import { cleanup, makeWorkspace, readJsonOutput, runCli } from './helpers.mjs';

describe('diffFindings', () => {
  const finding = (id, status) => ({ id, status, severity: 'warn', summary: `${id} is ${status}` });

  test('reports additions, status changes, and removals once each', () => {
    const before = [finding('a', 'pass'), finding('b', 'pass'), finding('c', 'warn')];
    const after = [finding('a', 'fail'), finding('b', 'pass'), finding('d', 'warn')];
    const changes = diffFindings(before, after);
    assert.deepEqual(changes.changed.map((entry) => [entry.id, entry.from, entry.to]), [['a', 'pass', 'fail']]);
    assert.deepEqual(changes.added.map((entry) => entry.id), ['d']);
    assert.deepEqual(changes.removed.map((entry) => entry.id), ['c']);
    assert.equal(countChanges(changes), 3);
  });

  test('reports nothing when every status is unchanged', () => {
    const before = [finding('a', 'pass')];
    const after = [finding('a', 'pass')];
    assert.deepEqual(diffFindings(before, after), { added: [], changed: [], removed: [] });
  });

  test('renders a first run, an unchanged run, and a changed run distinctly', () => {
    const empty = { added: [], changed: [], removed: [] };
    assert.match(renderChanges(empty, null), /no previous run/);
    assert.match(renderChanges(empty, '2026-01-01T00:00:00.000Z'), /changes: none since/);
    const text = renderChanges(diffFindings([finding('a', 'pass')], [finding('a', 'fail')]), '2026-01-01T00:00:00.000Z');
    assert.match(text, /changed {2}a {2}pass -> fail/);
  });
});

describe('--compare', () => {
  let root;
  afterEach(() => {
    if (root) cleanup(root);
  });

  /**
   * Add a second package declaring an existing plugin id.
   *
   * @param {string} workspace Workspace root.
   * @param {string} name Plugin package name.
   * @returns {void}
   */
  function addPlugin(workspace, name) {
    const directory = join(workspace, `plugin-${name.split('/').pop()}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    writeFileSync(join(directory, 'index.js'), 'export default {};');
  }

  test('reports the first run, then no change, then a status change against the previous record', () => {
    root = makeWorkspace({ 'plugin/package.json': JSON.stringify({ name: '@local/dup', main: 'index.js' }) });
    writeFileSync(join(root, 'plugin', 'index.js'), 'export default {};');
    const args = ['--json', '--compare', '--harness-version', '0.2.2'];

    const first = readJsonOutput(runCli(args, { cwd: root }));
    assert.equal(first.changes.since, null);
    assert.deepEqual(first.changes.added, []);
    assert.equal(
      first.findings.find((finding) => finding.id === 'plugin.duplicate-id').status,
      'pass',
      'one package per plugin id must pass before the duplicate is introduced',
    );

    const second = readJsonOutput(runCli(args, { cwd: root }));
    assert.equal(second.changes.since, first.generatedAt);
    assert.equal(countChanges(second.changes), 0);
    assert.equal(second.changes.changed.length, 0);

    addPlugin(root, '@local/dup');
    const third = readJsonOutput(runCli(args, { cwd: root }));
    const change = third.changes.changed.find((entry) => entry.id === 'plugin.duplicate-id');
    assert.ok(change, 'the duplicate id must be reported as a status change');
    assert.equal(change.from, 'pass');
    assert.equal(change.to, 'fail');
  });

  test('text output prints the comparison line', () => {
    root = makeWorkspace({});
    runCli(['--harness-version', '0.2.2'], { cwd: root });
    const text = runCli(['--harness-version', '0.2.2', '--compare'], { cwd: root }).stdout;
    assert.match(text, /changes: none since /);
  });
});
