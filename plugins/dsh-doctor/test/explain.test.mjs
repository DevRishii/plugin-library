import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { IMPLEMENTATIONS } from '../src/checks/index.mjs';
import { loadManifest } from '../src/registry.mjs';
import { cleanup, makeWorkspace, readJsonOutput, runCli } from './helpers.mjs';

const HISTORY_RELATIVE = '.dsh/doctor/history.jsonl';

describe('MVP-5 — --explain <id> links the recorded log line', () => {
  let root;
  beforeEach(() => {
    root = makeWorkspace({
      'plugin-a/package.json': JSON.stringify({ name: 'shared-plugin', main: 'index.js' }),
      'plugin-a/index.js': 'export default {};\n',
      'plugin-b/package.json': JSON.stringify({ name: 'shared-plugin', main: 'index.js' }),
      'plugin-b/index.js': 'export default {};\n',
    });
    const seed = runCli(['--harness-version', '0.2.2'], { cwd: root });
    assert.equal(seed.status, 1, 'the seed run must fail plugin.duplicate-id');
    assert.equal(existsSync(join(root, HISTORY_RELATIVE)), true, 'the seed run must record history');
  });
  afterEach(() => {
    cleanup(root);
  });

  test('text output prints the title, why, and a log link pointing at the recorded failure', () => {
    const check = loadManifest(IMPLEMENTATIONS).checks.find((entry) => entry.id === 'plugin.duplicate-id');
    const result = runCli(['--explain', 'plugin.duplicate-id'], { cwd: root });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes(check.title), 'the explanation must print the check title');
    assert.ok(result.stdout.includes(check.why), 'the explanation must print the why text');

    const match = /log: \.dsh\/doctor\/history\.jsonl:(\d+)/.exec(result.stdout);
    assert.ok(match, `stdout must link the history line, got:\n${result.stdout}`);
    const lineNumber = Number(match[1]);

    const lines = readFileSync(join(root, HISTORY_RELATIVE), 'utf8').split(/\r?\n/);
    assert.ok(lineNumber >= 1 && lineNumber <= lines.length, `line ${lineNumber} is outside the history file`);
    const record = JSON.parse(lines[lineNumber - 1]);
    const recorded = (record.findings ?? []).find(
      (finding) => finding.id === 'plugin.duplicate-id' && finding.status === 'fail',
    );
    assert.ok(recorded, `line ${lineNumber} must contain a failed plugin.duplicate-id finding`);
  });

  test('--json returns {check, latest, occurrences} with the relative log path', () => {
    const result = runCli(['--explain', 'plugin.duplicate-id', '--json'], { cwd: root });
    assert.equal(result.status, 0);
    const explanation = readJsonOutput(result);
    for (const key of ['check', 'latest', 'occurrences']) {
      assert.ok(Object.hasOwn(explanation, key), `explanation is missing ${key}`);
    }
    assert.equal(explanation.check.id, 'plugin.duplicate-id');
    assert.ok(explanation.check.why.trim() !== '');
    assert.ok(explanation.latest, 'a failure was recorded, so latest must not be null');
    assert.equal(explanation.latest.logPath, HISTORY_RELATIVE);
    assert.equal(explanation.latest.status, 'fail');
    assert.equal(typeof explanation.latest.line, 'number');
    assert.ok(Array.isArray(explanation.occurrences));
    assert.ok(explanation.occurrences.length >= 1);
    assert.equal(explanation.occurrences[0].line, explanation.latest.line);
  });

  test('an unknown check id exits 2 and writes to stderr', () => {
    const result = runCli(['--explain', 'not-a-check'], { cwd: root });
    assert.equal(result.status, 2);
    assert.ok(result.stderr.trim() !== '', 'the failure must be reported on stderr');
    assert.match(result.stderr, /not-a-check/);
  });
});
