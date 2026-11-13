import assert from 'node:assert/strict';
import { existsSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { cleanup, findingsById, makeWorkspace, readJsonOutput, runCli, snapshotTree } from './helpers.mjs';

describe('MVP-4 — dry-run, then apply on confirm, no silent repairs', () => {
  describe('stale lock and unignored state', () => {
    let root;
    beforeEach(() => {
      root = makeWorkspace({
        '.gitignore': 'node_modules\n',
        '.dsh/locks/stale.lock': '',
      });
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(join(root, '.dsh', 'locks', 'stale.lock'), twoHoursAgo, twoHoursAgo);
    });
    afterEach(() => {
      cleanup(root);
    });

    test('--fix without --yes reports a dry run and writes nothing', () => {
      const before = snapshotTree(root);
      const result = runCli(['--fix', '--no-history'], { cwd: root });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /dry run/i);
      assert.match(result.stdout, /would apply/);
      assert.doesNotMatch(result.stdout, /^Applied:/m);
      assert.deepEqual(snapshotTree(root), before);
    });

    test('--fix --yes applies the mutations and the rerun reports pass', () => {
      const result = runCli(['--fix', '--yes', '--no-history'], { cwd: root });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /Applied/);

      const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
      assert.ok(gitignore.split(/\r?\n/).includes('.dsh/'), '.gitignore must gain a .dsh/ line');
      assert.equal(existsSync(join(root, '.dsh', 'locks', 'stale.lock')), false, 'the stale lock must be removed');

      const rerun = readJsonOutput(runCli(['--json', '--no-history'], { cwd: root }));
      const findings = findingsById(rerun);
      assert.equal(findings.get('state.orphaned-lock').status, 'pass');
      assert.equal(findings.get('workspace.gitignore-missing-state').status, 'pass');
    });
  });

  describe('two packages declaring one plugin id', () => {
    let root;
    beforeEach(() => {
      root = makeWorkspace({
        'package.json': JSON.stringify({ name: 'fixture', dependencies: { 'left-pad': '^1.0.0' } }),
        'plugin-a/package.json': JSON.stringify({ name: 'shared-plugin', main: 'index.js' }),
        'plugin-a/index.js': 'export default {};\n',
        'plugin-b/package.json': JSON.stringify({ name: 'shared-plugin', main: 'index.js' }),
        'plugin-b/index.js': 'export default {};\n',
      });
    });
    afterEach(() => {
      cleanup(root);
    });

    test('--fix --yes never deletes a plugin directory or applies a command/manual fix', () => {
      const before = snapshotTree(root);
      const result = runCli(
        ['--fix', '--yes', '--no-history', '--json', '--harness-version', '0.2.2'],
        { cwd: root },
      );
      assert.equal(result.status, 1);
      const report = readJsonOutput(result);
      const findings = findingsById(report);

      const duplicate = findings.get('plugin.duplicate-id');
      assert.equal(duplicate.status, 'fail');
      assert.equal(duplicate.fix.type, 'manual');

      assert.equal(existsSync(join(root, 'plugin-a')), true, 'plugin-a must survive');
      assert.equal(existsSync(join(root, 'plugin-b')), true, 'plugin-b must survive');
      assert.deepEqual(snapshotTree(root), before, 'a manual or command fix must not touch the workspace');
      assert.equal(existsSync(join(root, 'node_modules')), false, 'a command fix must not run');
      assert.equal(existsSync(join(root, 'pnpm-lock.yaml')), false, 'a command fix must not write a lockfile');

      assert.equal(report.fixRun.applied.length, 0);
      assert.equal(report.fixRun.planned.length, 0);
      assert.ok(
        report.fixRun.refused.some((line) => line.startsWith('plugin.duplicate-id:')),
        'the manual duplicate-id fix must be reported as not applied',
      );
      assert.ok(
        report.fixRun.refused.some((line) => line.startsWith('install.lockfile-missing:')),
        'a command fix must be reported as not applied',
      );
    });
  });
});
