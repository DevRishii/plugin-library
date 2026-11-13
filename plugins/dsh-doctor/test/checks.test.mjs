import assert from 'node:assert/strict';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { runDoctor } from '../src/doctor.mjs';
import { cleanup, findingsById, makeWorkspace } from './helpers.mjs';

/**
 * Run a single check against a fixture and return its finding.
 *
 * @param {string} root Workspace root.
 * @param {string} id Check id.
 * @returns {object} Finding for that id.
 */
function runCheck(root, id) {
  const report = runDoctor({ root, history: false, harnessVersion: '0.2.2', only: [id] });
  return findingsById(report).get(id);
}

describe('install.lockfile-drift matches dependency names at entry boundaries', () => {
  let root;
  afterEach(() => {
    if (root) cleanup(root);
  });

  test('a scoped sibling entry does not satisfy an unscoped dependency', () => {
    root = makeWorkspace({
      'package.json': JSON.stringify({ name: 'fixture', dependencies: { foo: '^1.0.0' } }),
      'pnpm-lock.yaml': "packages:\n  '@scope/foo@1.0.0':\n    resolution: {integrity: sha512-x}\n",
    });
    const finding = runCheck(root, 'install.lockfile-drift');
    assert.equal(finding.status, 'fail');
    assert.match(finding.summary, /1 declared dependencies are absent/);
    assert.ok(
      finding.evidence.some((item) => item.detail.includes('foo is declared but not recorded')),
      'evidence must name the dependency the lockfile does not record',
    );
  });

  test('a real entry satisfies the dependency', () => {
    root = makeWorkspace({
      'package.json': JSON.stringify({ name: 'fixture', dependencies: { foo: '^1.0.0' } }),
      'pnpm-lock.yaml': 'packages:\n  foo@1.0.0:\n    resolution: {integrity: sha512-x}\n',
    });
    assert.equal(runCheck(root, 'install.lockfile-drift').status, 'pass');
  });

  test('a scoped dependency is satisfied by its own scoped entry', () => {
    root = makeWorkspace({
      'package.json': JSON.stringify({ name: 'fixture', dependencies: { '@scope/foo': '^1.0.0' } }),
      'pnpm-lock.yaml': "packages:\n  '@scope/foo@1.0.0':\n    resolution: {integrity: sha512-x}\n",
    });
    assert.equal(runCheck(root, 'install.lockfile-drift').status, 'pass');
  });
});

describe('plugin.client-bundle-stale compares source files, not the src directory', () => {
  let root;
  afterEach(() => {
    if (root) cleanup(root);
  });

  /**
   * Build a plugin fixture and stamp its modification times.
   *
   * @param {{packageAt: Date, bundleAt: Date, sourceAt: Date, directoryAt: Date}} stamps Times to apply.
   * @returns {string} Workspace root.
   */
  function pluginFixture(stamps) {
    const workspace = makeWorkspace({
      'plugin/package.json': JSON.stringify({ name: '@local/p', main: 'index.js' }),
      'plugin/index.js': 'export default {};',
      'plugin/client.js': 'export const bundle = true;',
      'plugin/src/index.js': 'export default {};',
    });
    utimesSync(join(workspace, 'plugin/package.json'), stamps.packageAt, stamps.packageAt);
    utimesSync(join(workspace, 'plugin/index.js'), stamps.packageAt, stamps.packageAt);
    utimesSync(join(workspace, 'plugin/client.js'), stamps.bundleAt, stamps.bundleAt);
    utimesSync(join(workspace, 'plugin/src/index.js'), stamps.sourceAt, stamps.sourceAt);
    utimesSync(join(workspace, 'plugin/src'), stamps.directoryAt, stamps.directoryAt);
    return workspace;
  }

  test('an edited file inside src marks the bundle stale even when the src directory is older', () => {
    const early = new Date(Date.now() - 600_000);
    const later = new Date(Date.now() - 300_000);
    root = pluginFixture({ packageAt: early, bundleAt: early, sourceAt: later, directoryAt: early });
    const finding = runCheck(root, 'plugin.client-bundle-stale');
    assert.equal(finding.status, 'warn');
    assert.ok(finding.evidence.some((item) => item.path === 'plugin/client.js'));
  });

  test('a bundle newer than every source passes', () => {
    const early = new Date(Date.now() - 600_000);
    const later = new Date(Date.now() - 60_000);
    root = pluginFixture({ packageAt: early, bundleAt: later, sourceAt: early, directoryAt: early });
    assert.equal(runCheck(root, 'plugin.client-bundle-stale').status, 'pass');
  });
});
