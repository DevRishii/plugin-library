#!/usr/bin/env node
/**
 * Tests for scripts/hive/model-tier.mjs and the hive-switch preflight contract.
 *
 * Positive, negative, and empty-scan cases run against committed static
 * fixtures under tests/fixtures/model-tiers so the suite stays offline and
 * deterministic. The Windows case builds an isolated temp Hivemind home and
 * asserts that a refused switch leaves the active profile and opencode.json
 * byte-for-byte unchanged.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadModelTiers,
  resolveModelTier,
  verifyModelTiers,
} from '../../scripts/hive/model-tier.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURES_ROOT = join(REPO_ROOT, 'tests', 'fixtures', 'model-tiers');
const CLI_PATH = join(REPO_ROOT, 'scripts', 'hive', 'model-tier.mjs');
const PACK_ROOT = join(REPO_ROOT, 'packs', 'hivemind');
const REAL_PROFILES = [
  'argon-deepseek',
  'chatgpt-deepseek',
  'claude-hybrid',
  'claude-native',
  'opencode-go-max',
];

function fixture(name) {
  return join(FIXTURES_ROOT, name);
}

test('a valid registry override cannot mask an invalid raw switch mapping', t => {
  const root = mkdtempSync(join(tmpdir(), 'tier-mask-test-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  mkdirSync(join(root, 'config'), {recursive:true});
  cpSync(join(PACK_ROOT, 'profiles'), join(root, 'profiles'), {recursive:true});
  cpSync(join(PACK_ROOT, 'opencode/agents'), join(root, 'opencode/agents'), {recursive:true});
  const registry = JSON.parse(readFileSync(join(REPO_ROOT,'config/model-tiers.json'),'utf8'));
  registry.profile_overrides = {'chatgpt-deepseek': {'spec-architect':'openai/gpt-6.1-sol'}};
  writeFileSync(join(root,'config/model-tiers.json'), JSON.stringify(registry));
  const profilePath = join(root,'profiles/chatgpt-deepseek.json');
  const profile = JSON.parse(readFileSync(profilePath,'utf8'));
  profile.agent_models['spec-architect'] = profile.agent_models.builder;
  writeFileSync(profilePath, JSON.stringify(profile));
  const report = verifyModelTiers({root});
  assert.equal(report.ok,false);
  assert.ok(report.violations.some(v => v.message.startsWith('raw switch mapping:')));
});

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
}

function parseData(run) {
  const stdout = String(run.stdout ?? '').trim();
  assert.equal(run.status, 0, `expected exit 0 (stderr: ${String(run.stderr ?? '').trim()})`);
  assert.notEqual(stdout, '', 'expected JSON on stdout');
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed), ['data'], 'success envelope must only carry `data`');
  return parsed.data;
}

function parseFailure(run, expectedStatus, expectedCode) {
  assert.equal(run.status, expectedStatus, `expected exit ${expectedStatus} (stderr: ${String(run.stderr ?? '').trim()})`);
  const stderr = String(run.stderr ?? '').trim();
  assert.notEqual(stderr, '', 'expected a JSON error on stderr');
  const parsed = JSON.parse(stderr);
  assert.ok(parsed.error, 'expected an `error` object');
  assert.equal(parsed.error.code, expectedCode);
  assert.equal(typeof parsed.error.message, 'string');
  return parsed;
}

function verifyFixture(name) {
  return runCli(['verify', '--strict', '--json', '--root', fixture(name)]);
}

test('registry defines four tiers and all five profiles resolve an architect above the builder', () => {
  const registry = loadModelTiers({ root: REPO_ROOT });
  assert.deepEqual(Object.keys(registry.tiers), ['1', '2', '3', '4']);
  assert.equal(registry.tiers[1], 'cheap');
  assert.equal(registry.tiers[4], 'frontier');
  assert.equal(registry.invariant, 'tier(spec-architect) >= tier(builder) + 1');

  const profileIds = REAL_PROFILES.slice().sort();
  for (const profileId of profileIds) {
    const resolved = resolveModelTier({
      root: REPO_ROOT,
      profile: profileId,
      role: 'spec-architect',
    });
    assert.equal(resolved.profile, profileId);
    assert.equal(resolved.role, 'spec-architect');
    assert.equal(resolved.compliant, true, `${profileId} must be tier compliant`);
    assert.ok(Number.isInteger(resolved.tier), `${profileId} spec-architect tier must be an integer`);
    assert.ok(Number.isInteger(resolved.builder.tier), `${profileId} builder tier must be an integer`);
    assert.ok(
      resolved.tier >= resolved.builder.tier + 1,
      `${profileId}: spec-architect tier ${resolved.tier} must exceed builder tier ${resolved.builder.tier}`,
    );
    assert.ok(resolved.tier >= 3, `${profileId}: spec-architect must resolve a strong (>= 3) tier`);
    assert.equal(resolved.architects['spec-architect'].tier, resolved.tier);
  }
});

test('valid fixture verifies strictly with zero violations', () => {
  const data = parseData(verifyFixture('valid'));
  assert.equal(data.ok, true);
  assert.equal(data.profile_count, 1);
  assert.deepEqual(data.violations, []);
  assert.equal(data.profiles[0].profile_id, 'valid-profile');
  assert.equal(data.profiles[0].tiers['spec-architect'], 4);
  assert.equal(data.profiles[0].tiers.builder, 1);
  assert.equal(data.baseline.violations.length, 0);
  assert.equal(data.baseline.agents.length, 3);
});

test('unknown model in a profile fails with unknown_model', () => {
  const parsed = parseFailure(verifyFixture('unknown-model'), 2, 'unknown_model');
  assert.match(parsed.error.message, /unknown model 'test\/ghost'/);
  assert.equal(parsed.data.ok, false);
  const violation = parsed.data.violations.find(
    (entry) => entry.code === 'unknown_model' && entry.role === 'spec-architect',
  );
  assert.ok(violation, 'expected an unknown_model violation for spec-architect');
  assert.equal(violation.model, 'test/ghost');
});

test('equal tiers in a profile fail the strict invariant', () => {
  const parsed = parseFailure(verifyFixture('equal-tiers'), 2, 'tier_violation');
  assert.equal(parsed.data.ok, false);
  const profile = parsed.data.profiles[0];
  assert.equal(profile.profile_id, 'equal-profile');
  assert.equal(profile.tiers.builder, 3);
  assert.equal(profile.tiers['spec-architect'], 3);
  assert.ok(profile.violations.length >= 1);
  assert.ok(profile.violations.every((entry) => entry.code === 'tier_violation'));
  const roles = profile.violations.map((entry) => entry.role);
  assert.ok(roles.includes('spec-architect'));
  assert.ok(roles.includes('hivemind-architect'));
});

test('equal tiers in baseline agent frontmatter fail the strict invariant', () => {
  const parsed = parseFailure(verifyFixture('baseline-equal'), 2, 'tier_violation');
  assert.equal(parsed.data.baseline.violations.length >= 1, true);
  const violation = parsed.data.baseline.violations[0];
  assert.equal(violation.scope, 'baseline');
  assert.equal(violation.code, 'tier_violation');
  assert.equal(parsed.data.profiles[0].compliant, true);
});

test('an empty profile scan is refused instead of reporting a vacuous pass', () => {
  const parsed = parseFailure(verifyFixture('empty-scan'), 2, 'refused');
  assert.match(parsed.error.message, /zero profiles/);
  assert.match(parsed.error.message, /refusing to verify an empty scan/);
  assert.ok(String(parsed.data.profiles_dir).endsWith('profiles'));
});

test('profile_overrides that collapse the tier gap fail', () => {
  const parsed = parseFailure(verifyFixture('override-invalid'), 2, 'tier_violation');
  const profile = parsed.data.profiles[0];
  assert.deepEqual(profile.overrides, {
    builder: 'test/smart-worker',
    'spec-architect': 'test/smart-architect',
  });
  assert.equal(profile.tiers.builder, 3);
  assert.equal(profile.tiers['spec-architect'], 3);
  assert.equal(profile.violations[0].code, 'tier_violation');
});

test('profile_overrides that reference an unknown model fail at registry load', () => {
  const parsed = parseFailure(verifyFixture('override-unknown-model'), 2, 'unknown_model');
  assert.match(parsed.error.message, /profile_overrides\.valid-profile\.spec-architect/);
  assert.equal(parsed.data.profile, 'valid-profile');
  assert.equal(parsed.data.role, 'spec-architect');
  assert.equal(parsed.data.model, 'test/ghost');
});

test('repository default layout verifies all five profiles strictly', () => {
  const data = parseData(runCli(['verify', '--strict', '--json']));
  assert.equal(data.ok, true);
  assert.equal(data.profile_count, 5);
  assert.deepEqual(data.violations, []);
  assert.deepEqual(
    data.profiles.map((profile) => profile.profile_id),
    REAL_PROFILES,
  );
});

test('CLI resolve returns a strong tier for every installed profile', () => {
  for (const profileId of REAL_PROFILES) {
    const data = parseData(
      runCli(['resolve', '--role', 'spec-architect', '--profile', profileId, '--json', '--root', REPO_ROOT]),
    );
    assert.equal(data.profile, profileId);
    assert.equal(data.role, 'spec-architect');
    assert.equal(data.compliant, true);
    assert.ok(data.tier > data.builder.tier);
    assert.ok(data.tier >= 3);
  }
});

test('a UTF-8 BOM on a profile does not break verification on Windows', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'model-tier-bom-'));
  try {
    cpSync(fixture('valid'), tmp, { recursive: true });
    const profilePath = join(tmp, 'packs', 'hivemind', 'profiles', 'valid-profile.json');
    const text = readFileSync(profilePath, 'utf8');
    writeFileSync(profilePath, `\uFEFF${text}`);
    const report = verifyModelTiers({ root: tmp });
    assert.equal(report.ok, true);
    assert.deepEqual(report.violations, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('both installers ship the guard, registry, and portable vault kit', () => {
  // Normalise Windows separators so the same marker list covers both scripts.
  const shell = readFileSync(join(PACK_ROOT, 'install.sh'), 'utf8').replaceAll('\\', '/');
  const powershell = readFileSync(join(PACK_ROOT, 'install.ps1'), 'utf8').replaceAll('\\', '/');
  for (const marker of ['scripts/hive', 'config/model-tiers.json', 'vault-kit']) {
    assert.ok(shell.includes(marker), `install.sh must install ${marker}`);
    assert.ok(powershell.includes(marker), `install.ps1 must install ${marker}`);
  }
});

test(
  'Windows hive-switch refuses a tier violation without touching active_profile or opencode.json',
  { skip: process.platform !== 'win32' },
  () => {
    const powershell = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    if (!existsSync(powershell)) return;

    const tmp = mkdtempSync(join(tmpdir(), 'hive-switch-tier-'));
    try {
      const hm = join(tmp, 'hivemind');
      const oc = join(tmp, 'opencode');
      mkdirSync(join(hm, 'profiles'), { recursive: true });
      mkdirSync(join(hm, 'config'), { recursive: true });
      mkdirSync(join(hm, 'scripts', 'hive'), { recursive: true });
      mkdirSync(join(oc, 'agents'), { recursive: true });

      copyFileSync(
        join(REPO_ROOT, 'config', 'model-tiers.json'),
        join(hm, 'config', 'model-tiers.json'),
      );
      for (const module of ['contracts.mjs', 'model-tier.mjs']) {
        copyFileSync(
          join(REPO_ROOT, 'scripts', 'hive', module),
          join(hm, 'scripts', 'hive', module),
        );
      }
      for (const agent of ['builder.md', 'hivemind-architect.md', 'spec-architect.md']) {
        copyFileSync(
          join(PACK_ROOT, 'opencode', 'agents', agent),
          join(oc, 'agents', agent),
        );
      }
      copyFileSync(
        join(PACK_ROOT, 'opencode', 'AGENTS.md'),
        join(oc, 'AGENTS.md'),
      );

      const activeProfile = 'chatgpt-deepseek';
      copyFileSync(
        join(PACK_ROOT, 'profiles', `${activeProfile}.json`),
        join(hm, 'profiles', `${activeProfile}.json`),
      );

      // Clone a real profile and collapse architect tiers down to the builder
      // tier so the strict preflight must reject the whole roster.
      const bad = JSON.parse(
        readFileSync(join(PACK_ROOT, 'profiles', `${activeProfile}.json`), 'utf8'),
      );
      bad.profile_id = 'bad-profile';
      bad.agent_models['spec-architect'] = bad.agent_models.builder;
      bad.agent_models['hivemind-architect'] = bad.agent_models.builder;
      writeFileSync(
        join(hm, 'profiles', 'bad-profile.json'),
        `${JSON.stringify(bad, null, 2)}\n`,
      );

      const opencodePath = join(oc, 'opencode.json');
      const activePath = join(hm, 'active_profile');
      const configBefore = '{\n  "model": "sentinel/model"\n}\n';
      const activeBefore = `${activeProfile}\n`;
      writeFileSync(opencodePath, configBefore);
      writeFileSync(activePath, activeBefore);
      const specBefore = readFileSync(join(oc, 'agents', 'spec-architect.md'), 'utf8');

      const result = spawnSync(
        powershell,
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(PACK_ROOT, 'hive-switch.ps1'),
          'bad-profile',
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: 120000,
          env: {
            ...process.env,
            HIVEMIND_HOME: hm,
            OPENCODE_DIR: oc,
            PATH: `${dirname(process.execPath)};${process.env.PATH ?? ''}`,
          },
        },
      );

      assert.notEqual(result.status, 0, 'switch must fail closed');
      const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      assert.match(combined, /model-tier preflight failed/);
      assert.match(combined, /tier_violation|model-tier violation/);
      assert.equal(readFileSync(opencodePath, 'utf8'), configBefore);
      assert.equal(readFileSync(activePath, 'utf8'), activeBefore);
      assert.equal(readFileSync(join(oc, 'agents', 'spec-architect.md'), 'utf8'), specBefore);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);
