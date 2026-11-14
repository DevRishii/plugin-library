import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve('scripts/hive/vault-lifecycle.mjs');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vault-lifecycle-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({name:'sample-app',type:'module'}));
  writeFileSync(join(root, 'src/index.mjs'), 'export function greet() { return "hello"; }\n');
  writeFileSync(join(root, 'AGENTS.md'), '# Existing instructions\nKeep this prose.\n');
  return root;
}
function run(root, ...args) {
  const r = spawnSync(process.execPath, [cli, ...args, '--root', root, '--json'], {encoding:'utf8', env:{...process.env,CI:''}});
  let body;
  try { body = JSON.parse(r.stdout || r.stderr); } catch { body = {}; }
  return {...r, body};
}
function ok(r) { assert.equal(r.status, 0, r.stderr || r.stdout); return r.body.data; }
function snapshot(root) {
  const files = {};
  function walk(dir) { for (const e of readdirSync(dir, {withFileTypes:true})) {
    const p = join(dir,e.name); if(e.isDirectory()) walk(p); else files[p.slice(root.length)] = readFileSync(p).toString('base64');
  }}
  walk(root); return files;
}
test('plan and refusal do not mutate a fresh repo', t => {
  const root = fixture(t), before = snapshot(root);
  assert.equal(ok(run(root,'plan','--goal','first')).action, 'prompt_create');
  assert.equal(run(root,'scaffold').status, 2);
  assert.deepEqual(snapshot(root), before);
});

test('bare --root refuses instead of selecting cwd', () => {
  const r = spawnSync(process.execPath, [cli,'scaffold','--yes','--root','--json'], {encoding:'utf8'});
  assert.equal(r.status,2); assert.match(r.stderr,/root requires a directory/);
});
test('scaffold, refresh changed/new sources and preserve human prose', t => {
  const root = fixture(t);
  const created = ok(run(root,'scaffold','--yes'));
  assert.equal(created.index_exit,0); assert.equal(created.check_exit,0);
  assert.equal(ok(run(root,'detect')).state,'present_healthy');
  assert.equal(ok(run(root,'plan','--goal','second')).action,'prompt_update');
  assert.match(readFileSync(join(root,'AGENTS.md'),'utf8'),/Keep this prose/);
  assert.equal(run(root,'scaffold','--yes').status,2);
  const before = snapshot(root);
  assert.equal(run(root,'update').status,2);
  assert.deepEqual(snapshot(root),before);
  writeFileSync(join(root,'src/index.mjs'),'\nexport function greet() { return "changed"; }\n');
  writeFileSync(join(root,'src/new.mjs'),'export const latest = 42;\n');
  const updated = ok(run(root,'update','--yes','--goal','second'));
  assert.equal(updated.index_exit,0); assert.equal(updated.check_exit,0);
  assert.equal(ok(run(root,'detect')).state,'present_healthy');
  assert.equal(readFileSync(join(root,'src/new.mjs'),'utf8'),'export const latest = 42;\n');
});
test('state suppresses duplicate prompts and rejects corrupt records', t => {
  const root = fixture(t);
  ok(run(root,'state','record','--goal','one','--choice','no'));
  assert.equal(ok(run(root,'plan','--goal','one')).action,'none');
  writeFileSync(join(root,'.hive/lifecycle/one.json'),'broken');
  const bad = run(root,'plan','--goal','one');
  assert.equal(bad.status,2); assert.equal(bad.body.error.code,'state_corrupt');
  assert.equal(run(root,'state','get','--goal','../escape').status,2);
});
test('preflight collision leaves application files unchanged', t => {
  const root = fixture(t);
  mkdirSync(join(root,'scripts'));
  writeFileSync(join(root,'scripts/vault.mjs'),'// existing application code\n');
  const before = snapshot(root);
  assert.notEqual(run(root,'scaffold','--yes').status,0);
  assert.deepEqual(snapshot(root),before);
  assert.equal(existsSync(join(root,'.opencode/vault/00-MOC.md')),false);
});

test('explicit custom vault directory propagates through scaffold and detection', t => {
  const root = fixture(t);
  const made = ok(run(root, 'scaffold', '--yes', '--vault-dir', 'docs/context'));
  assert.equal(made.index_exit, 0); assert.equal(made.check_exit, 0);
  assert.equal(ok(run(root, 'detect', '--vault-dir', 'docs/context')).state, 'present_healthy');
  assert.equal(existsSync(join(root, '.opencode/vault/00-MOC.md')), false);
});

test('index refuses an escaping symlink destination', t => {
  const root = fixture(t), outside = mkdtempSync(join(tmpdir(), 'vault-outside-'));
  t.after(() => rmSync(outside, {recursive:true, force:true}));
  ok(run(root, 'scaffold', '--yes'));
  const indexDir = join(root, '.opencode/vault/.index');
  rmSync(indexDir, {recursive:true, force:true});
  symlinkSync(outside, indexDir, process.platform === 'win32' ? 'junction' : 'dir');
  const r = spawnSync(process.execPath, [join(root, 'scripts/vault.mjs'), 'index', '--root', root, '--json'], {encoding:'utf8'});
  assert.notEqual(r.status, 0, r.stdout);
  assert.deepEqual(readdirSync(outside), []);
});
