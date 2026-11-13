import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { join } from 'node:path';
import { runDoctor } from '../src/doctor.mjs';
import { cleanup, findingsById, makeWorkspace, readJsonOutput, runCli } from './helpers.mjs';

const STATUS_KEYS = ['pass', 'info', 'warn', 'fail', 'skip'];

/**
 * Reduce findings to the fields that survive JSON serialization, so a CLI
 * report can be compared with a direct `runDoctor` report.
 *
 * @param {object[]} findings Findings.
 * @returns {object[]} Comparable projections.
 */
function comparable(findings) {
  return findings.map((finding) => ({
    id: finding.id,
    group: finding.group,
    severity: finding.severity,
    title: finding.title,
    status: finding.status,
    summary: finding.summary,
    evidence: finding.evidence,
    fixType: finding.fix?.type ?? null,
  }));
}

describe('MVP-3 — table output, --json, exit codes', () => {
  describe('table output', () => {
    let root;
    beforeEach(() => {
      root = makeWorkspace({
        'package.json': JSON.stringify({ name: 'fixture', dependencies: { 'left-pad': '^1.0.0' } }),
      });
    });
    afterEach(() => {
      cleanup(root);
    });

    test('non-JSON output starts with a header row and has one row per finding', () => {
      const report = readJsonOutput(runCli(['--json', '--no-history'], { cwd: root }));
      const result = runCli(['--no-history'], { cwd: root });
      assert.equal(result.status, report.exitCode);
      const [table] = result.stdout.split('\n\n');
      const lines = table.split('\n');
      assert.equal(lines.length, report.findings.length + 1, 'expected a header plus one row per finding');
      const header = lines[0];
      for (const column of ['STATUS', 'SEVERITY', 'GROUP', 'CHECK', 'SUMMARY']) {
        assert.ok(header.includes(column), `table header is missing ${column}`);
      }
      report.findings.forEach((finding, index) => {
        const row = lines[index + 1];
        assert.ok(row.includes(finding.id), `row ${index + 1} does not name ${finding.id}`);
        assert.ok(
          row.includes(finding.status.toUpperCase()),
          `row ${index + 1} does not show status ${finding.status.toUpperCase()}`,
        );
      });
    });
  });

  describe('--json', () => {
    let root;
    beforeEach(() => {
      root = makeWorkspace({
        'package.json': JSON.stringify({ name: 'fixture', dependencies: { 'left-pad': '^1.0.0' } }),
      });
    });
    afterEach(() => {
      cleanup(root);
    });

    test('parses and matches runDoctor report fields and counts', () => {
      const result = runCli(
        ['--json', '--no-history', '--harness-version', '0.2.2'],
        { cwd: root },
      );
      const report = readJsonOutput(result);
      assert.equal(result.status, report.exitCode);
      for (const key of ['tool', 'generatedAt', 'root', 'harnessVersion', 'findings', 'summary', 'warnings', 'exitCode']) {
        assert.ok(Object.hasOwn(report, key), `report is missing field ${key}`);
      }
      assert.equal(report.tool, 'dsh-doctor');
      assert.equal(report.harnessVersion, '0.2.2');
      assert.ok(!Number.isNaN(Date.parse(report.generatedAt)));

      const direct = runDoctor({ root, history: false, harnessVersion: '0.2.2' });
      assert.deepEqual(report.summary, direct.summary);
      assert.deepEqual(comparable(report.findings), comparable(direct.findings));
      assert.deepEqual(report.warnings, direct.warnings);

      assert.equal(report.summary.total, report.findings.length);
      const statusTotal = STATUS_KEYS.reduce((sum, key) => sum + report.summary[key], 0);
      assert.equal(statusTotal, report.findings.length);
      assert.equal(statusTotal, report.summary.total);
      assert.equal(findingsById(report).size, report.findings.length);

      for (const finding of report.findings) {
        for (const key of ['id', 'group', 'severity', 'title', 'status', 'summary', 'evidence', 'fix']) {
          assert.ok(Object.hasOwn(finding, key), `${finding.id} is missing field ${key}`);
        }
        assert.ok(STATUS_KEYS.includes(finding.status), `${finding.id} has status ${finding.status}`);
        assert.ok(Array.isArray(finding.evidence), `${finding.id} evidence must be an array`);
        for (const item of finding.evidence) {
          assert.equal(typeof item.path, 'string', `${finding.id} evidence is missing a path`);
          if (Object.hasOwn(item, 'line')) {
            assert.equal(typeof item.line, 'number', `${finding.id} evidence line must be a number`);
          }
        }
      }
    });
  });

  describe('exit codes', () => {
    let cleanRoot;
    let failRoot;
    let warnRoot;
    beforeEach(() => {
      cleanRoot = makeWorkspace({});
      failRoot = makeWorkspace({
        'package.json': JSON.stringify({ name: 'fixture', dependencies: { 'left-pad': '^1.0.0' } }),
      });
      warnRoot = makeWorkspace({ '.gitignore': 'node_modules\n' });
    });
    afterEach(() => {
      cleanup(cleanRoot);
      cleanup(failRoot);
      cleanup(warnRoot);
    });

    test('exit 0 for a workspace where nothing fails', () => {
      const result = runCli(['--json', '--no-history'], { cwd: cleanRoot });
      assert.equal(result.status, 0);
      const report = readJsonOutput(result);
      assert.equal(report.summary.fail, 0);
      assert.equal(report.summary.warn, 0);
      assert.equal(report.exitCode, 0);
    });

    test('exit 1 when a fail finding exists', () => {
      const result = runCli(['--json', '--no-history'], { cwd: failRoot });
      assert.equal(result.status, 1);
      const report = readJsonOutput(result);
      assert.ok(report.summary.fail > 0);
      assert.equal(report.exitCode, 1);
    });

    test('exit 2 for an unknown --group value', () => {
      const result = runCli(['--group', 'bogus', '--no-history'], { cwd: cleanRoot });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /unknown group/);
      assert.match(result.stderr, /bogus/);
    });

    test('exit 2 for an unknown --check or --mute id instead of reporting nothing', () => {
      for (const flag of ['--check', '--mute']) {
        const result = runCli([flag, 'not-a-check', '--json', '--no-history'], { cwd: cleanRoot });
        assert.equal(result.status, 2, `${flag} with an unknown id must be a usage error`);
        assert.equal(result.stdout, '', `${flag} with an unknown id must not print a report`);
        assert.match(result.stderr, /unknown check id/);
        assert.match(result.stderr, /not-a-check/);
      }
    });

    test('exit 2 for a --root that does not exist', () => {
      const result = runCli(['--root', join(cleanRoot, 'missing'), '--json', '--no-history'], { cwd: cleanRoot });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /does not exist/);
    });

    test('--strict turns a warn-only workspace into exit 1', () => {
      const normal = runCli(['--json', '--no-history'], { cwd: warnRoot });
      const report = readJsonOutput(normal);
      assert.equal(report.summary.fail, 0);
      assert.equal(report.summary.warn, 1);
      assert.equal(normal.status, 0);

      const strict = runCli(['--json', '--no-history', '--strict'], { cwd: warnRoot });
      assert.equal(strict.status, 1);
      assert.equal(readJsonOutput(strict).exitCode, 1);
    });
  });
});
