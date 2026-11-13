import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { compareVersions, parseRange, parseVersion, satisfiesRange } from '../src/semver.mjs';
import { cleanup, makeWorkspace } from './helpers.mjs';

describe('semver', () => {
  let root;
  before(() => {
    root = makeWorkspace({});
  });
  after(() => {
    cleanup(root);
  });

  test('parseVersion accepts bare versions and rejects partial ones', () => {
    assert.deepEqual(parseVersion('0.2.2'), { major: 0, minor: 2, patch: 2, pre: [] });
    assert.deepEqual(parseVersion('0.2.2-rc.1'), { major: 0, minor: 2, patch: 2, pre: ['rc', '1'] });
    assert.equal(parseVersion('0.2'), null);
    assert.equal(parseVersion('v0.2.2'), null);
    assert.equal(parseVersion(''), null);
  });

  test('prerelease ordering: 0.2.2-rc.1 satisfies >=0.2.0 <0.3.0 and is lower than 0.2.2', () => {
    const releaseCandidate = parseVersion('0.2.2-rc.1');
    const release = parseVersion('0.2.2');
    assert.ok(compareVersions(releaseCandidate, release) < 0);
    assert.ok(compareVersions(release, releaseCandidate) > 0);
    assert.equal(satisfiesRange('0.2.2-rc.1', '>=0.2.0 <0.3.0'), true);
    assert.equal(satisfiesRange('0.2.2-rc.1', '>=0.2.2'), false);
    assert.equal(satisfiesRange('0.2.2', '>=0.2.2'), true);
  });

  test('caret ranges stay below the next breaking minor for 0.x', () => {
    assert.equal(satisfiesRange('0.2.0', '^0.2.0'), true);
    assert.equal(satisfiesRange('0.2.5', '^0.2.0'), true);
    assert.equal(satisfiesRange('0.2.2-rc.1', '^0.2.0'), true);
    assert.equal(satisfiesRange('0.3.0', '^0.2.0'), false);
    assert.equal(satisfiesRange('0.1.9', '^0.2.0'), false);
  });

  test('tilde ranges stay below the next minor', () => {
    assert.equal(satisfiesRange('0.2.1', '~0.2.1'), true);
    assert.equal(satisfiesRange('0.2.9', '~0.2.1'), true);
    assert.equal(satisfiesRange('0.2.0', '~0.2.1'), false);
    assert.equal(satisfiesRange('0.3.0', '~0.2.1'), false);
  });

  test('compound ranges require every comparator', () => {
    assert.equal(satisfiesRange('0.2.0', '>=0.2.0 <0.3.0'), true);
    assert.equal(satisfiesRange('0.2.99', '>=0.2.0 <0.3.0'), true);
    assert.equal(satisfiesRange('0.1.9', '>=0.2.0 <0.3.0'), false);
    assert.equal(satisfiesRange('0.3.0', '>=0.2.0 <0.3.0'), false);
    assert.equal(satisfiesRange('0.2.2', '=0.2.2'), true);
    assert.equal(satisfiesRange('0.2.3', '=0.2.2'), false);
  });

  test('caret on 0.0.x pins the patch component', () => {
    assert.equal(satisfiesRange('0.0.3', '^0.0.3'), true);
    assert.equal(satisfiesRange('0.0.4', '^0.0.3'), false);
    assert.equal(satisfiesRange('0.0.999', '^0.0.3'), false);
    assert.equal(satisfiesRange('0.1.0', '^0.0.3'), false);
  });

  test('an operator separated from its version by a space still parses', () => {
    assert.notEqual(parseRange('>= 1.0.0'), null);
    assert.equal(satisfiesRange('1.2.0', '>= 1.0.0'), true);
    assert.equal(satisfiesRange('0.9.0', '>= 1.0.0'), false);
    assert.equal(satisfiesRange('0.2.2', '>= 0.2.0 < 0.3.0'), true);
    assert.equal(satisfiesRange('0.3.0', '>= 0.2.0 < 0.3.0'), false);
  });

  test('build metadata is accepted and does not change precedence', () => {
    assert.deepEqual(parseVersion('0.2.2+build.5'), { major: 0, minor: 2, patch: 2, pre: [] });
    assert.equal(satisfiesRange('0.2.1+build', '>=0.2.0 <0.3.0'), true);
    assert.equal(satisfiesRange('0.2.2+build', '0.2.2'), true);
    assert.equal(satisfiesRange('0.2.2+build', '>0.2.2'), false);
  });

  test('* accepts any parsed version and rejects an unparsable one', () => {
    assert.deepEqual(parseRange('*'), { any: true, comparators: [] });
    assert.equal(parseRange('nonsense'), null);
    assert.equal(satisfiesRange('0.0.0', '*'), true);
    assert.equal(satisfiesRange('99.1.2', '*'), true);
    assert.equal(satisfiesRange('0.2.2-rc.1', '*'), true);
    assert.equal(satisfiesRange('not-a-version', '*'), false);
  });
});
