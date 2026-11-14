#!/usr/bin/env node
/**
 * Executable end-to-end model-tier tests against every committed Hivemind
 * profile. Both the programmatic verifier and the CLI must agree that
 * `tier(spec-architect) >= tier(builder) + 1`; profiles are discovered from
 * disk and cross-checked against PATH-MAP so a new profile cannot be skipped.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import test from 'node:test';

import { verifyModelTiers } from '../../scripts/hive/model-tier.mjs';
import {
  REPO_ROOT,
  dataOf,
  runModelTier,
} from '../../scripts/hive/e2e-fixtures.mjs';

const PROFILES_DIR = join(REPO_ROOT, 'packs', 'hivemind', 'profiles');
const PATH_MAP = JSON.parse(
  readFileSync(join(REPO_ROOT, 'docs', 'context-vault', 'PATH-MAP.json'), 'utf8'),
);

const PROFILE_IDS = readdirSync(PROFILES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
  .map((entry) => basename(entry.name, '.json'))
  .sort();

const DECLARED_PROFILE_IDS = PATH_MAP.paths.profile_configs
  .map((rel) => basename(rel, '.json'))
  .sort();

function assertStrictGap(profileId, tiers, label) {
  assert.ok(
    Number.isInteger(tiers.builder),
    `${label}: ${profileId} builder tier must be an integer`,
  );
  assert.ok(
    Number.isInteger(tiers['spec-architect']),
    `${label}: ${profileId} spec-architect tier must be an integer`,
  );
  assert.ok(
    tiers['spec-architect'] >= tiers.builder + 1,
    `${label}: ${profileId} spec-architect tier ${tiers['spec-architect']} must exceed builder tier ${tiers.builder}`,
  );
  assert.ok(
    tiers['spec-architect'] >= 3,
    `${label}: ${profileId} spec-architect must resolve a strong tier`,
  );
}

test('all committed profiles satisfy tier(spec-architect) > tier(builder)', () => {
  assert.ok(PROFILE_IDS.length > 0, 'no profile JSON files found');
  assert.deepEqual(
    PROFILE_IDS,
    DECLARED_PROFILE_IDS,
    'every PATH-MAP profile must have an executable e2e tier check',
  );

  const report = verifyModelTiers({ root: REPO_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.violations, null, 2));
  assert.deepEqual(report.violations, []);
  assert.equal(report.profile_count, PROFILE_IDS.length);
  assert.deepEqual(
    report.profiles.map((profile) => profile.profile_id),
    PROFILE_IDS,
  );

  for (const profile of report.profiles) {
    assert.equal(profile.compliant, true, `${profile.profile_id} must be compliant`);
    assert.deepEqual(profile.violations, []);
    assertStrictGap(profile.profile_id, profile.tiers, 'verify');
  }

  assert.deepEqual(report.baseline.violations, []);
  const baseline = new Map(
    report.baseline.agents.map((agent) => [agent.agent, agent]),
  );
  const spec = baseline.get('spec-architect');
  const builder = baseline.get('builder');
  assert.ok(spec, 'baseline spec-architect frontmatter must be present');
  assert.ok(builder, 'baseline builder frontmatter must be present');
  assert.ok(
    spec.tier >= builder.tier + 1,
    `baseline spec-architect tier ${spec.tier} must exceed builder tier ${builder.tier}`,
  );
});

test('CLI verify and resolve enforce the strict gap for every real profile', () => {
  const verified = dataOf(
    runModelTier(['verify', '--strict', '--root', REPO_ROOT]),
  );
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.violations, []);
  assert.equal(verified.profile_count, PROFILE_IDS.length);
  assert.equal(
    verified.invariant,
    'tier(spec-architect) >= tier(builder) + 1',
  );

  const verifiedById = new Map(
    verified.profiles.map((profile) => [profile.profile_id, profile]),
  );

  for (const profileId of PROFILE_IDS) {
    const report = verifiedById.get(profileId);
    assert.ok(report, `verify report must include ${profileId}`);
    assert.equal(report.compliant, true, `${profileId} must be compliant`);
    assertStrictGap(profileId, report.tiers, 'verify --strict');

    const resolved = dataOf(
      runModelTier([
        'resolve',
        '--role',
        'spec-architect',
        '--profile',
        profileId,
        '--root',
        REPO_ROOT,
      ]),
    );
    assert.equal(resolved.profile, profileId);
    assert.equal(resolved.role, 'spec-architect');
    assert.equal(resolved.compliant, true);
    assert.equal(resolved.tier, report.tiers['spec-architect']);
    assert.equal(resolved.builder.tier, report.tiers.builder);
    assert.ok(
      resolved.tier >= resolved.builder.tier + 1,
      `${profileId}: resolved spec-architect tier ${resolved.tier} must exceed builder tier ${resolved.builder.tier}`,
    );
    assert.equal(
      resolved.architects['spec-architect'].tier,
      resolved.tier,
      `${profileId}: architect map must mirror the resolved spec-architect tier`,
    );
  }
});
