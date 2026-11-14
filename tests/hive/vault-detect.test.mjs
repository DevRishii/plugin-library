#!/usr/bin/env node
/**
 * Unit tests for scripts/hive/vault-detect.mjs.
 *
 * Every case runs against committed static fixtures so the suite stays offline,
 * deterministic, and independent of any project-local vault.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { detectVault } from '../../scripts/hive/vault-detect.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURES_ROOT = join(REPO_ROOT, 'tests', 'fixtures', 'vault-detect');
const CLI_PATH = join(REPO_ROOT, 'scripts', 'hive', 'vault-detect.mjs');

const DATA_KEYS = ['health', 'missing', 'repo_root', 'sentinels', 'state', 'stats', 'vault_dir'];
const EMPTY_STATS = { notes: 0, symbols: 0, index_status: 'missing' };
const FIXTURE_NAMES = [
  'absent',
  'config-bad-schema',
  'config-override',
  'healthy',
  'partial',
  'partial-cli-only',
  'partial-moc-no-title',
  'partial-moc-unparseable',
  'unhealthy',
];

function fixture(name) {
  return join(FIXTURES_ROOT, name);
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
}

function parseData(run) {
  const stdout = String(run.stdout ?? '').trim();
  assert.notEqual(stdout, '', 'expected JSON on stdout (stderr: ' + String(run.stderr ?? '').trim() + ')');
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed), ['data'], 'JSON envelope must only carry `data`');
  return parsed.data;
}

function parseError(run) {
  const stderr = String(run.stderr ?? '').trim();
  assert.notEqual(stderr, '', 'expected a JSON error on stderr');
  const parsed = JSON.parse(stderr);
  assert.ok(parsed.error, 'expected an `error` object');
  assert.equal(typeof parsed.error.code, 'string');
  assert.equal(typeof parsed.error.message, 'string');
  return parsed.error;
}

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function snapshotTree(dir) {
  const rootStat = statSync(dir);
  const entries = [];
  const walk = (current) => {
    const dirents = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const dirent of dirents) {
      const full = join(current, dirent.name);
      const stats = statSync(full);
      entries.push({
        path: toPosix(relative(dir, full)),
        kind: dirent.isDirectory() ? 'dir' : 'file',
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
      if (dirent.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return { rootMtimeMs: rootStat.mtimeMs, entries };
}

test('fixture tree contains exactly the documented directories', () => {
  assert.deepEqual(readdirSync(FIXTURES_ROOT).sort(), FIXTURE_NAMES);
});

test('absent: neither sentinel exists, exit 0', () => {
  const run = runCli(['--root', fixture('absent'), '--json']);
  assert.equal(run.status, 0);
  assert.equal(String(run.stderr ?? '').trim(), '');
  const data = parseData(run);
  assert.deepEqual(Object.keys(data).sort(), DATA_KEYS);
  assert.equal(data.state, 'absent');
  assert.equal(data.vault_dir, '.opencode/vault');
  assert.equal(data.repo_root, toPosix(realpathSync(fixture('absent'))));
  assert.deepEqual(data.sentinels, [
    { path: '.opencode/vault/00-MOC.md', exists: false },
    { path: 'scripts/vault.mjs', exists: false },
  ]);
  assert.deepEqual(data.missing, ['.opencode/vault/00-MOC.md', 'scripts/vault.mjs']);
  assert.deepEqual(data.health, { exit_code: 0, error_code: null });
  assert.deepEqual(data.stats, EMPTY_STATS);
});

test('partial: MOC without CLI sentinel, exit 0', () => {
  const run = runCli(['--root', fixture('partial'), '--json']);
  assert.equal(run.status, 0);
  const data = parseData(run);
  assert.equal(data.state, 'partial');
  assert.deepEqual(data.sentinels, [
    { path: '.opencode/vault/00-MOC.md', exists: true },
    { path: 'scripts/vault.mjs', exists: false },
  ]);
  assert.deepEqual(data.missing, ['scripts/vault.mjs']);
  assert.deepEqual(data.health, { exit_code: 0, error_code: null });
  assert.deepEqual(data.stats, EMPTY_STATS);
});

test('partial: CLI sentinel without MOC, exit 0', () => {
  const run = runCli(['--root', fixture('partial-cli-only'), '--json']);
  assert.equal(run.status, 0);
  const data = parseData(run);
  assert.equal(data.state, 'partial');
  assert.deepEqual(data.sentinels, [
    { path: '.opencode/vault/00-MOC.md', exists: false },
    { path: 'scripts/vault.mjs', exists: true },
  ]);
  assert.deepEqual(data.missing, ['.opencode/vault/00-MOC.md']);
  assert.deepEqual(data.health, { exit_code: 0, error_code: null });
});

test('partial: both sentinels but MOC frontmatter missing entirely', () => {
  const run = runCli(['--root', fixture('partial-moc-unparseable'), '--json']);
  assert.equal(run.status, 0);
  const data = parseData(run);
  assert.equal(data.state, 'partial');
  assert.deepEqual(data.missing, []);
  assert.deepEqual(data.health, { exit_code: 2, error_code: 'invalid_frontmatter' });
  assert.deepEqual(data.stats, EMPTY_STATS);
});

test('partial: both sentinels but MOC frontmatter lacks a title', () => {
  const run = runCli(['--root', fixture('partial-moc-no-title'), '--json']);
  assert.equal(run.status, 0);
  const data = parseData(run);
  assert.equal(data.state, 'partial');
  assert.deepEqual(data.missing, []);
  assert.deepEqual(data.health, { exit_code: 2, error_code: 'invalid_frontmatter' });
});

test('present_healthy: strict check passes and stats are reported', () => {
  const run = runCli(['--root', fixture('healthy'), '--json']);
  assert.equal(run.status, 0);
  assert.equal(String(run.stderr ?? '').trim(), '');
  const data = parseData(run);
  assert.equal(data.state, 'present_healthy');
  assert.deepEqual(data.sentinels, [
    { path: '.opencode/vault/00-MOC.md', exists: true },
    { path: 'scripts/vault.mjs', exists: true },
  ]);
  assert.deepEqual(data.missing, []);
  assert.deepEqual(data.health, { exit_code: 0, error_code: null });
  assert.deepEqual(data.stats, { notes: 6, symbols: 42, index_status: 'fresh' });
});

test('present_unhealthy: typed error code is surfaced and stats fall back', () => {
  const run = runCli(['--root', fixture('unhealthy'), '--json']);
  assert.equal(run.status, 0);
  const data = parseData(run);
  assert.equal(data.state, 'present_unhealthy');
  assert.deepEqual(data.health, { exit_code: 2, error_code: 'broken_link' });
  assert.deepEqual(data.stats, EMPTY_STATS);
});

test('vault.config.json relocates the vault directory', () => {
  const run = runCli(['--root', fixture('config-override'), '--json']);
  assert.equal(run.status, 0);
  const data = parseData(run);
  assert.equal(data.state, 'present_healthy');
  assert.equal(data.vault_dir, 'docs/vault');
  assert.deepEqual(data.sentinels, [
    { path: 'docs/vault/00-MOC.md', exists: true },
    { path: 'scripts/vault.mjs', exists: true },
  ]);
  assert.deepEqual(data.missing, []);
});

test('unknown vault.config.json schema_version exits 2', () => {
  const run = runCli(['--root', fixture('config-bad-schema'), '--json']);
  assert.equal(run.status, 2);
  assert.equal(String(run.stdout ?? '').trim(), '');
  const error = parseError(run);
  assert.equal(error.code, 'refused');
  assert.match(error.message, /schema_version/);
});

test('--vault-dir with a traversal segment exits 2', () => {
  const run = runCli(['--root', fixture('healthy'), '--vault-dir', '../escape', '--json']);
  assert.equal(run.status, 2);
  assert.equal(String(run.stdout ?? '').trim(), '');
  const error = parseError(run);
  assert.equal(error.code, 'refused');
  assert.match(error.message, /traversal/);
});

test('--vault-dir override reports the overridden sentinel paths', () => {
  const run = runCli(['--root', fixture('partial'), '--vault-dir', 'custom-vault', '--json']);
  assert.equal(run.status, 0);
  const data = parseData(run);
  assert.equal(data.state, 'absent');
  assert.equal(data.vault_dir, 'custom-vault');
  assert.deepEqual(data.sentinels, [
    { path: 'custom-vault/00-MOC.md', exists: false },
    { path: 'scripts/vault.mjs', exists: false },
  ]);
});

test('missing --root exits 3', () => {
  const run = runCli(['--json']);
  assert.equal(run.status, 3);
  const error = parseError(run);
  assert.equal(error.code, 'not_found');
  assert.match(error.message, /--root/);
});

test('--root without a value exits 3', () => {
  const run = runCli(['--root', '--json']);
  assert.equal(run.status, 3);
  const error = parseError(run);
  assert.equal(error.code, 'not_found');
});

test('--help exits 0 and prints usage', () => {
  const run = runCli(['--help']);
  assert.equal(run.status, 0);
  assert.match(String(run.stdout ?? ''), /Usage: node scripts\/hive\/vault-detect\.mjs/);
});

test('--quiet suppresses human-readable output', () => {
  const run = runCli(['--root', fixture('absent'), '--quiet']);
  assert.equal(run.status, 0);
  assert.equal(String(run.stdout ?? '').trim(), '');
  assert.equal(String(run.stderr ?? '').trim(), '');
});

test('human-readable mode names the resolved state', () => {
  const run = runCli(['--root', fixture('healthy')]);
  assert.equal(run.status, 0);
  assert.match(String(run.stdout ?? ''), /vault state: present_healthy/);
});

test('detectVault() matches the CLI payload for healthy and unhealthy fixtures', () => {
  for (const name of ['healthy', 'unhealthy', 'partial-moc-unparseable']) {
    const fromLibrary = detectVault({ root: fixture(name) });
    const fromCli = parseData(runCli(['--root', fixture(name), '--json']));
    assert.deepEqual(fromLibrary, fromCli, `library/CLI payload mismatch for ${name}`);
  }
});

test('detectVault() honors an explicit vaultDir option', () => {
  // The flag wins over vault.config.json, so the relocated MOC disappears while
  // the default `scripts/vault.mjs` sentinel is still found.
  const data = detectVault({ root: fixture('config-override'), vaultDir: '.opencode/vault' });
  assert.equal(data.vault_dir, '.opencode/vault');
  assert.equal(data.state, 'partial');
  assert.deepEqual(data.missing, ['.opencode/vault/00-MOC.md']);
});

test('detection never mutates fixture entries or mtimes', () => {
  const before = new Map(FIXTURE_NAMES.map((name) => [name, snapshotTree(fixture(name))]));
  for (const name of FIXTURE_NAMES) {
    const run = runCli(['--root', fixture(name), '--json']);
    assert.ok(run.status === 0 || run.status === 2, `unexpected exit ${run.status} for ${name}`);
  }
  for (const name of FIXTURE_NAMES) {
    assert.deepEqual(snapshotTree(fixture(name)), before.get(name), `fixture ${name} was mutated by detection`);
  }
});