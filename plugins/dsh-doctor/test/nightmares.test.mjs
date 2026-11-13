import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportToNightmares } from '../src/nightmares.mjs';
import { cleanup, makeWorkspace, readJsonOutput, runCli } from './helpers.mjs';

const DEFECT_STATUSES = new Set(['fail', 'warn', 'info']);
const FINDING_KEYS = ['id', 'group', 'severity', 'title', 'status', 'summary', 'evidence', 'fix'];

describe('--nightmares backlog feed', () => {
  let failRoot;
  let cleanRoot;
  beforeEach(() => {
    failRoot = makeWorkspace({
      'package.json': JSON.stringify({ name: 'fixture', dependencies: { 'left-pad': '^1.0.0' } }),
    });
    cleanRoot = makeWorkspace({});
  });
  afterEach(() => {
    cleanup(failRoot);
    cleanup(cleanRoot);
  });

  test('prints parseable defect-only JSON for a workspace with a failing finding', () => {
    const result = runCli(['--nightmares', '--no-history', '--harness-version', '0.2.2'], { cwd: failRoot });
    assert.equal(result.status, 1);
    const feed = readJsonOutput(result);
    assert.equal(feed.source, 'dsh-doctor');
    assert.ok(!Number.isNaN(Date.parse(feed.generatedAt)), 'generatedAt must be an ISO timestamp');
    assert.equal(feed.harnessVersion, '0.2.2');
    assert.ok(feed.findings.length > 0, 'expected at least one defect');
    for (const finding of feed.findings) {
      assert.ok(DEFECT_STATUSES.has(finding.status), `${finding.id} has status ${finding.status}`);
      assert.ok(Array.isArray(finding.evidence), `${finding.id} evidence must be an array`);
      assert.ok(finding.evidence.length > 0, `${finding.id} evidence must not be empty`);
      for (const key of FINDING_KEYS) {
        assert.ok(Object.hasOwn(finding, key), `${finding.id} is missing field ${key}`);
      }
    }
  });

  test('emits an empty findings array on a workspace where every check passes or skips', () => {
    const result = runCli(['--nightmares', '--no-history'], { cwd: cleanRoot });
    assert.equal(result.status, 0);
    const feed = readJsonOutput(result);
    assert.equal(feed.source, 'dsh-doctor');
    assert.deepEqual(feed.findings, []);
  });

  test('lists the checks that passed so the board can close a repaired entry', () => {
    const root = makeWorkspace({ 'plugin/package.json': JSON.stringify({ name: '@local/only', main: 'index.js' }) });
    writeFileSync(join(root, 'plugin', 'index.js'), 'export default {};');
    const result = runCli(['--nightmares', '--no-history', '--harness-version', '0.2.2'], { cwd: root });
    const feed = readJsonOutput(result);
    assert.ok(Array.isArray(feed.passing), 'the feed must carry a passing list');
    assert.ok(feed.passing.includes('plugin.duplicate-id'), 'a passing duplicate-id check must be listed');
    cleanup(root);
  });

  test('wins over --json and never prints the full report', () => {
    const result = runCli(['--nightmares', '--json', '--no-history', '--harness-version', '0.2.2'], {
      cwd: failRoot,
    });
    const parsed = readJsonOutput(result);
    assert.ok(Object.hasOwn(parsed, 'source'), 'expected the compact feed shape');
    assert.equal(Object.hasOwn(parsed, 'summary'), false, 'summary belongs to the full report');
    assert.equal(Object.hasOwn(parsed, 'root'), false, 'root belongs to the full report');
    assert.equal(Object.hasOwn(parsed, 'tool'), false, 'tool belongs to the full report');
    assert.ok(parsed.findings.length > 0);
  });

  test('rejects --fix with a usage error instead of repairing anything', () => {
    const result = runCli(['--nightmares', '--fix', '--no-history'], { cwd: failRoot });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '', '--fix with --nightmares must not print a feed');
    assert.match(result.stderr, /--nightmares/);
    assert.match(result.stderr, /--fix/);
    assert.match(result.stderr, /cannot be combined/);
  });
});

describe('reportToNightmares', () => {
  test('drops pass and skip entries while preserving evidence and fix', () => {
    const passEvidence = [{ path: 'package.json' }];
    const skipEvidence = [{ path: '.dsh/settings.json' }];
    const failEvidence = [{ path: 'package.json', detail: 'no lockfile' }];
    const failFix = { type: 'command', summary: 'pnpm install', command: 'pnpm install', steps: ['writes the lockfile'] };
    const warnEvidence = [{ path: '.gitignore' }];
    const report = {
      generatedAt: '2026-01-02T03:04:05.000Z',
      harnessVersion: '0.2.2',
      findings: [
        { id: 'a.pass', group: 'install', severity: 'error', title: 'A', status: 'pass', summary: 'ok', evidence: passEvidence, fix: null },
        { id: 'b.skip', group: 'install', severity: 'warn', title: 'B', status: 'skip', summary: 'not applicable', evidence: skipEvidence, fix: null },
        { id: 'c.fail', group: 'install', severity: 'error', title: 'C', status: 'fail', summary: 'broken', evidence: failEvidence, fix: failFix },
        { id: 'd.warn', group: 'config', severity: 'warn', title: 'D', status: 'warn', summary: 'suspicious', evidence: warnEvidence, fix: null },
      ],
    };
    const feed = reportToNightmares(report);
    assert.equal(feed.source, 'dsh-doctor');
    assert.equal(feed.generatedAt, report.generatedAt);
    assert.equal(feed.harnessVersion, '0.2.2');
    assert.deepEqual(feed.findings.map((finding) => finding.id), ['c.fail', 'd.warn']);
    const [fail, warn] = feed.findings;
    assert.equal(fail.evidence, failEvidence, 'evidence must pass through unchanged');
    assert.equal(fail.fix, failFix, 'fix must pass through unchanged');
    assert.equal(warn.evidence, warnEvidence);
    assert.equal(warn.fix, null);
  });
});
