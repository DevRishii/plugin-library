import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { IMPLEMENTATIONS } from '../src/checks/index.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { DoctorError, GROUPS, SEVERITIES, loadManifest, validateManifest } from '../src/registry.mjs';
import { parseRange } from '../src/semver.mjs';
import { cleanup, findingsById, makeWorkspace, readJsonOutput, runCli } from './helpers.mjs';

const MANIFEST_PATH = fileURLToPath(new URL('../src/checks.data.json', import.meta.url));
const MANIFEST_DOCUMENT = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const FIX_TYPES = new Set(['command', 'mutation', 'manual']);

/**
 * Clone the shipped manifest and mutate it, so a rejected manifest never leaks
 * into another test or onto disk.
 *
 * @param {(checks: object[]) => void} mutate Mutation applied to the clone.
 * @returns {object} Manifest document with the mutation applied.
 */
function mutatedManifest(mutate) {
  const document = structuredClone(MANIFEST_DOCUMENT);
  mutate(document.checks);
  return document;
}

/**
 * Assert that `validateManifest` rejects a document with one specific code.
 *
 * @param {object} document Mutated manifest document.
 * @param {string} code Expected `DoctorError.code`.
 * @returns {void}
 */
function rejectsWithCode(document, code) {
  assert.throws(
    () => validateManifest(document, IMPLEMENTATIONS),
    (error) => {
      assert.ok(error instanceof DoctorError, `expected a DoctorError, got ${error?.constructor?.name}`);
      assert.equal(error.code, code);
      return true;
    },
  );
}

describe('MVP-1 — registry has ids, severity, evidence, and a typed fix per check', () => {
  let root;
  beforeEach(() => {
    root = makeWorkspace({});
  });
  afterEach(() => {
    cleanup(root);
  });

  test('every check declares a non-empty id, group, severity, title, why, and a parseable harness range', () => {
    const checks = MANIFEST_DOCUMENT.checks;
    assert.ok(Array.isArray(checks) && checks.length > 0, 'the manifest must declare checks');
    const ids = new Set();
    for (const check of checks) {
      assert.equal(typeof check.id, 'string', 'id must be a string');
      assert.ok(check.id.trim() !== '', 'id must be non-empty');
      assert.ok(!ids.has(check.id), `duplicate check id ${check.id}`);
      ids.add(check.id);
      assert.ok(GROUPS.includes(check.group), `${check.id} declares an unknown group ${check.group}`);
      assert.ok(SEVERITIES.includes(check.severity), `${check.id} declares an unknown severity ${check.severity}`);
      assert.equal(typeof check.title, 'string', `${check.id} must declare a title`);
      assert.ok(check.title.trim() !== '', `${check.id} must declare a non-empty title`);
      assert.equal(typeof check.why, 'string', `${check.id} must declare why it exists`);
      assert.ok(check.why.trim() !== '', `${check.id} must declare a non-empty why`);
      assert.equal(typeof check.harness, 'string', `${check.id} must declare a harness range`);
      assert.notEqual(parseRange(check.harness), null, `${check.id} declares an unparsable harness range ${check.harness}`);
    }
  });

  test('every manifest id has an implementation in IMPLEMENTATIONS', () => {
    for (const check of MANIFEST_DOCUMENT.checks) {
      assert.equal(typeof IMPLEMENTATIONS[check.id], 'function', `${check.id} has no implementation`);
    }
    assert.deepEqual(
      Object.keys(IMPLEMENTATIONS).sort(),
      MANIFEST_DOCUMENT.checks.map((check) => check.id).sort(),
      'the implementation map and the manifest must name the same checks',
    );
    assert.doesNotThrow(() => loadManifest(IMPLEMENTATIONS));
  });

  describe('a failing finding carries evidence and a typed fix', () => {
    let failRoot;
    beforeEach(() => {
      failRoot = makeWorkspace({
        'package.json': JSON.stringify({ name: 'fixture', dependencies: { 'left-pad': '^1.0.0' } }),
      });
    });
    afterEach(() => {
      cleanup(failRoot);
    });

    test('every fail finding has non-empty evidence and a null or typed fix', () => {
      const report = runDoctor({ root: failRoot, history: false, harnessVersion: '0.2.2' });
      const failing = report.findings.filter((finding) => finding.status === 'fail');
      assert.ok(failing.length > 0, 'the fixture must produce at least one fail finding');
      for (const finding of report.findings) {
        assert.ok(
          finding.fix === null || FIX_TYPES.has(finding.fix.type),
          `${finding.id} has an invalid fix type ${finding.fix?.type}`,
        );
      }
      for (const finding of failing) {
        assert.ok(Array.isArray(finding.evidence), `${finding.id} must carry an evidence array`);
        assert.ok(finding.evidence.length > 0, `${finding.id} must carry at least one evidence item`);
      }
    });
  });

  describe('validateManifest rejects an invalid manifest with a typed DoctorError', () => {
    test('duplicate id', () => {
      rejectsWithCode(
        mutatedManifest((checks) => {
          checks.push(structuredClone(checks[0]));
        }),
        'manifest-duplicate-id',
      );
    });

    test('unknown group', () => {
      rejectsWithCode(
        mutatedManifest((checks) => {
          checks[0].group = 'bogus';
        }),
        'manifest-bad-group',
      );
    });

    test('unknown severity', () => {
      rejectsWithCode(
        mutatedManifest((checks) => {
          checks[0].severity = 'fatal';
        }),
        'manifest-bad-severity',
      );
    });

    test('unparsable harness range', () => {
      rejectsWithCode(
        mutatedManifest((checks) => {
          checks[0].harness = '>=0.2';
        }),
        'manifest-bad-range',
      );
    });

    test('id with no implementation', () => {
      rejectsWithCode(
        mutatedManifest((checks) => {
          checks.push({ ...structuredClone(checks[0]), id: 'install.not-implemented' });
        }),
        'manifest-no-impl',
      );
    });
  });
});

describe('MVP-2 — five groups', () => {
  let root;
  beforeEach(() => {
    root = makeWorkspace({});
  });
  afterEach(() => {
    cleanup(root);
  });

  test('GROUPS is the fixed five-group report order and every group has a check', () => {
    assert.deepEqual(GROUPS, ['install', 'plugin', 'config', 'state', 'workspace']);
    for (const group of GROUPS) {
      assert.ok(
        MANIFEST_DOCUMENT.checks.some((check) => check.group === group),
        `group ${group} has no check in the manifest`,
      );
    }
  });

  test('--group install returns only the manifest install checks', () => {
    const result = runCli(['--group', 'install', '--harness-version', '0.2.2', '--json', '--no-history'], {
      cwd: root,
    });
    assert.equal(result.status, 0);
    const report = readJsonOutput(result);
    assert.ok(report.findings.length > 0);
    for (const finding of report.findings) {
      assert.equal(finding.group, 'install', `${finding.id} leaked out of the install group`);
    }
    const expected = MANIFEST_DOCUMENT.checks
      .filter((check) => check.group === 'install')
      .map((check) => check.id);
    assert.deepEqual(
      report.findings.map((finding) => finding.id),
      expected,
    );
    assert.equal(findingsById(report).size, expected.length);
  });
});
