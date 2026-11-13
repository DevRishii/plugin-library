import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { IMPLEMENTATIONS } from '../src/checks/index.mjs';
import { loadManifest } from '../src/registry.mjs';
import { cleanup, findingsById, makeWorkspace, readJsonOutput, runCli } from './helpers.mjs';

describe('MVP-6 — checks ship as data with harness-version ranges', () => {
  let root;
  beforeEach(() => {
    root = makeWorkspace({});
  });
  afterEach(() => {
    cleanup(root);
  });

  test('0.2.2 selects install.duplicate-versions instead of skipping it for its range', () => {
    const result = runCli(['--harness-version', '0.2.2', '--json', '--no-history'], { cwd: root });
    assert.equal(result.status, 0);
    const report = readJsonOutput(result);
    assert.equal(report.harnessVersion, '0.2.2');
    const finding = findingsById(report).get('install.duplicate-versions');
    assert.ok(finding, 'install.duplicate-versions must be in the report');
    const skippedForVersion = finding.status === 'skip' && /applies to harness/.test(finding.summary);
    assert.equal(skippedForVersion, false, `unexpected version skip: ${finding.summary}`);
    if (finding.status === 'skip') {
      assert.match(finding.summary, /pnpm virtual store/, 'the only allowed skip is the missing pnpm store');
    }
  });

  test('0.3.0 skips install.duplicate-versions and names the installed version', () => {
    const result = runCli(['--harness-version', '0.3.0', '--json', '--no-history'], { cwd: root });
    const report = readJsonOutput(result);
    const finding = findingsById(report).get('install.duplicate-versions');
    assert.ok(finding);
    assert.equal(finding.status, 'skip');
    assert.match(finding.summary, /0\.3\.0/);
  });

  test('0.1.0 skips plugin.duplicate-id for version reasons', () => {
    const result = runCli(['--harness-version', '0.1.0', '--json', '--no-history'], { cwd: root });
    const report = readJsonOutput(result);
    const finding = findingsById(report).get('plugin.duplicate-id');
    assert.ok(finding);
    assert.equal(finding.status, 'skip');
    assert.match(finding.summary, /0\.1\.0/);
  });

  test('an undetectable harness version skips every ranged check and names the unknown version', () => {
    const result = runCli(['--json', '--no-history'], { cwd: root });
    const report = readJsonOutput(result);
    assert.equal(report.harnessVersion, null);
    const manifest = loadManifest(IMPLEMENTATIONS);
    const ranged = manifest.checks.filter((check) => check.harness !== '*');
    assert.ok(ranged.length > 0, 'the manifest must contain ranged checks');
    const findings = findingsById(report);
    for (const check of ranged) {
      const finding = findings.get(check.id);
      assert.ok(finding, `${check.id} must still be reported`);
      assert.equal(finding.status, 'skip', `${check.id} applied despite an unknown harness version`);
      assert.match(finding.summary, /unknown/, `${check.id} does not explain the unknown version`);
    }
  });
});
