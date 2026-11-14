import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_PLACEHOLDERS,
  AGENTS_VAULT_MARKERS,
  EXIT_CODES,
} from '../../scripts/hive/contracts.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const VAULT_KIT_DIR = join(REPO_ROOT, 'vault-kit');
const TEMPLATE_DIR = join(VAULT_KIT_DIR, 'template');
const FIXTURE_BASE = join(REPO_ROOT, 'tests', 'fixtures', 'vault-kit');
const CREATED_DIRS = [];

after(() => {
  for (const dir of CREATED_DIRS) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
});

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

test('required template files exist and context-librarian carries no model pin', () => {
  const required = [
    'README.md',
    'VERSION',
    'template/AGENTS.vault-snippet.md',
    'template/scripts/vault.mjs',
    'template/.opencode/vault/00-MOC.md',
    'template/.opencode/vault/README.md',
    'template/.opencode/vault/10-map/map-repo.md',
    'template/.opencode/vault/10-map/map-layers.md',
    'template/.opencode/vault/40-runbooks/runbook-swarm-run.md',
    'template/.opencode/vault/40-runbooks/runbook-handoff.md',
    'template/.opencode/vault/40-runbooks/runbook-context-budget.md',
    'template/.opencode/vault/90-handoffs/.gitkeep',
    'template/.opencode/vault/_schema/frontmatter.schema.json',
    'template/.opencode/vault/_schema/index.schema.json',
    'template/.opencode/vault/_schema/handoff.schema.json',
    'template/.opencode/vault/_schema/note-ids.json',
    'template/.opencode/agents/context-librarian.md',
    'template/.opencode/skills/context-vault/SKILL.md',
    'template/.opencode/commands/vault-brief.md',
    'template/.opencode/commands/vault-refresh.md',
    'template/.opencode/commands/vault-init.md',
  ];
  for (const rel of required) {
    assert.ok(existsSync(join(VAULT_KIT_DIR, rel)), `missing vault-kit/${rel}`);
  }

  const librarian = readFileSync(join(TEMPLATE_DIR, '.opencode/agents/context-librarian.md'), 'utf8');
  const fmMatch = librarian.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fmMatch, 'context-librarian.md missing YAML frontmatter');
  assert.ok(!/^model\s*:/m.test(fmMatch[1]), 'context-librarian.md must not hardcode a model pin');

  const snippet = readFileSync(join(TEMPLATE_DIR, 'AGENTS.vault-snippet.md'), 'utf8');
  assert.ok(snippet.includes(AGENTS_VAULT_MARKERS.BEGIN), 'missing begin marker');
  assert.ok(snippet.includes(AGENTS_VAULT_MARKERS.END), 'missing end marker');
});

test('vault-kit contains zero authoring-project coupling strings', () => {
  const forbidden = [
    ['Hive', 'ly'].join(''),
    ['pulse', 'sniffer'].join(''),
    ['unifiedEvent', 'Schema'].join(''),
  ];
  for (const file of walkFiles(VAULT_KIT_DIR)) {
    if (statSync(file).size > 2 * 1024 * 1024) continue;
    const text = readFileSync(file, 'utf8');
    for (const token of forbidden) {
      assert.ok(
        !text.includes(token),
        `forbidden token "${token}" leaked in ${relative(REPO_ROOT, file)}`,
      );
    }
  }
});

test('every {{...}} placeholder in vault-kit/template belongs to ALLOWED_PLACEHOLDERS', () => {
  const allowed = new Set(ALLOWED_PLACEHOLDERS);
  const placeholderRx = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  const anyCurliesRx = /\{\{([^{}\n]+)\}\}/g;

  for (const file of walkFiles(TEMPLATE_DIR)) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(TEMPLATE_DIR, file);
    for (const match of text.matchAll(anyCurliesRx)) {
      const token = match[1].trim();
      assert.ok(allowed.has(token), `disallowed placeholder {{${token}}} in ${rel}`);
    }
    for (const match of text.matchAll(placeholderRx)) {
      assert.ok(allowed.has(match[1]), `disallowed placeholder {{${match[1]}}} in ${rel}`);
    }
  }
});

test('instantiated vault-kit template executes all 7 CLI commands cleanly and enforces immutability', () => {
  mkdirSync(FIXTURE_BASE, { recursive: true });
  const workDir = join(FIXTURE_BASE, `tmp-inst-${process.pid}-${Date.now()}`);
  CREATED_DIRS.push(workDir);
  cpSync(TEMPLATE_DIR, workDir, { recursive: true });

  const replacements = {
    PROJECT_NAME: 'sample-service',
    PROJECT_ONE_LINER: 'Sample service repository for vault CLI tests',
    STACK: 'javascript, node',
    SRC_DIRS: 'src',
    TEST_CMD: 'node --test',
    VAULT_DIR: '.opencode/vault',
    DATE: '2026-11-14',
  };

  for (const file of walkFiles(workDir)) {
    if (/\.(md|json|mjs)$/i.test(file)) {
      let text = readFileSync(file, 'utf8');
      for (const [key, val] of Object.entries(replacements)) {
        text = text.replaceAll(`{{${key}}}`, val);
      }
      writeFileSync(file, text, 'utf8');
    }
  }

  mkdirSync(join(workDir, 'src'), { recursive: true });
  writeFileSync(
    join(workDir, 'src', 'example.mjs'),
    'export function greet(name) {\n  return `hello ${name}`;\n}\n',
    'utf8',
  );

  // Add a derived slice note and register it in note-ids.json + 00-MOC.md
  mkdirSync(join(workDir, '.opencode/vault/30-slices'), { recursive: true });
  writeFileSync(
    join(workDir, '.opencode/vault/30-slices/slice-core.md'),
    [
      '---',
      'id: slice-core',
      'title: Core Source Slice',
      'type: slice',
      'status: active',
      'owner: builder',
      'scope: core',
      'paths:',
      '  - src/example.mjs',
      'symbols:',
      '  - greet',
      'updated: 2026-11-14',
      'summary: Core greeting module slice pointer.',
      '---',
      '',
      '# Core Slice',
      '',
      'Entry link: [[moc-root]].',
      '',
    ].join('\n'),
    'utf8',
  );

  const noteIdsPath = join(workDir, '.opencode/vault/_schema/note-ids.json');
  const noteIds = JSON.parse(readFileSync(noteIdsPath, 'utf8'));
  noteIds.notes.push({
    id: 'slice-core',
    type: 'slice',
    path: '.opencode/vault/30-slices/slice-core.md',
  });
  writeFileSync(noteIdsPath, `${JSON.stringify(noteIds, null, 2)}\n`, 'utf8');

  const mocPath = join(workDir, '.opencode/vault/00-MOC.md');
  const mocText = readFileSync(mocPath, 'utf8');
  writeFileSync(mocPath, `${mocText.trimEnd()}\n- [[slice-core]] - core slice\n`, 'utf8');

  const cli = join(workDir, 'scripts', 'vault.mjs');
  const runVault = (args) =>
    spawnSync(process.execPath, [cli, ...args, '--root', workDir], {
      cwd: workDir,
      encoding: 'utf8',
    });

  const idx = runVault(['index', '--json']);
  assert.equal(idx.status, EXIT_CODES.OK, `index stderr: ${idx.stderr}`);
  const idxData = JSON.parse(idx.stdout).data;
  const noteCount = idxData.stats?.notes ?? idxData.notes ?? 0;
  assert.ok(noteCount >= 7, `expected >= 7 indexed notes, got ${JSON.stringify(idxData)}`);

  const chk = runVault(['check', '--strict', '--json']);
  assert.equal(chk.status, EXIT_CODES.OK, `check stderr: ${chk.stderr}`);

  const brf = runVault(['brief', '--task', 'moc-root', '--budget', '400', '--json']);
  assert.equal(brf.status, EXIT_CODES.OK, `brief stderr: ${brf.stderr}`);

  const fnd = runVault(['find', '--query', 'greet', '--json']);
  assert.equal(fnd.status, EXIT_CODES.OK, `find stderr: ${fnd.stderr}`);
  const fndData = JSON.parse(fnd.stdout).data;
  assert.ok(
    JSON.stringify(fndData).includes('greet'),
    `expected greet in find output: ${fnd.stdout}`,
  );

  const slc = runVault(['slice', '--file', 'src/example.mjs', '--symbol', 'greet', '--json']);
  assert.equal(slc.status, EXIT_CODES.OK, `slice stderr: ${slc.stderr}`);
  assert.ok(slc.stdout.includes('greet'));

  const hw1 = runVault([
    'handoff',
    'write',
    '--run',
    'run-1',
    '--slice',
    'slice-core',
    '--status',
    'done',
    '--owner',
    'builder',
    '--files',
    'src/example.mjs',
    '--tests',
    'node --test',
    '--body',
    '- implemented greet helper',
    '--json',
  ]);
  assert.equal(hw1.status, EXIT_CODES.OK, `handoff write stderr: ${hw1.stderr}`);
  assert.ok(
    existsSync(join(workDir, '.opencode/vault/90-handoffs/run-1/slice-core.handoff.md')),
    'handoff must default to 90-handoffs/',
  );

  // Overwriting a done handoff must refuse with exit code 3
  const hwDup = runVault([
    'handoff',
    'write',
    '--run',
    'run-1',
    '--slice',
    'slice-core',
    '--status',
    'done',
    '--owner',
    'builder',
    '--body',
    '- duplicate write',
    '--json',
  ]);
  assert.equal(hwDup.status, EXIT_CODES.NOT_FOUND, `expected exit 3 on overwrite: ${hwDup.stderr}`);

  const hl1 = runVault(['handoff', 'list', '--run', 'run-1', '--json']);
  assert.equal(hl1.status, EXIT_CODES.OK, `handoff list stderr: ${hl1.stderr}`);
  const hl1Data = JSON.parse(hl1.stdout).data;
  const listItems = Array.isArray(hl1Data) ? hl1Data : hl1Data.handoffs;
  assert.equal(listItems.length, 1);

  // Back-compat --runs-dir 40-runs override
  const hw40 = runVault([
    'handoff',
    'write',
    '--runs-dir',
    '40-runs',
    '--run',
    'run-legacy',
    '--slice',
    'slice-core',
    '--status',
    'done',
    '--owner',
    'builder',
    '--body',
    '- legacy runs dir write',
    '--json',
  ]);
  assert.equal(hw40.status, EXIT_CODES.OK, `handoff --runs-dir stderr: ${hw40.stderr}`);

  const hl40 = runVault(['handoff', 'list', '--runs-dir', '40-runs', '--run', 'run-legacy', '--json']);
  assert.equal(hl40.status, EXIT_CODES.OK, `handoff list --runs-dir stderr: ${hl40.stderr}`);

  const st = runVault(['stats', '--json']);
  assert.equal(st.status, EXIT_CODES.OK, `stats stderr: ${st.stderr}`);
  const stData = JSON.parse(st.stdout).data;
  assert.equal(stData.index_status ?? stData.freshness, 'fresh');
});

test('instantiated template honors a configured custom vault layout and rejects escaping paths', () => {
  mkdirSync(FIXTURE_BASE, { recursive: true });
  const workDir = join(FIXTURE_BASE, `tmp-custom-${process.pid}-${Date.now()}`);
  CREATED_DIRS.push(workDir);
  cpSync(TEMPLATE_DIR, workDir, { recursive: true });

  const replacements = {
    PROJECT_NAME: 'sample-service',
    PROJECT_ONE_LINER: 'Sample service repository for custom layout tests',
    STACK: 'javascript, node',
    SRC_DIRS: 'src',
    TEST_CMD: 'node --test',
    VAULT_DIR: 'docs/vault',
    DATE: '2026-11-14',
  };

  for (const file of walkFiles(workDir)) {
    if (/\.(md|json|mjs)$/i.test(file)) {
      let text = readFileSync(file, 'utf8');
      for (const [key, val] of Object.entries(replacements)) {
        text = text.replaceAll(`{{${key}}}`, val);
      }
      writeFileSync(file, text, 'utf8');
    }
  }

  // A custom layout moves the vault and records it in vault.config.json.
  mkdirSync(join(workDir, 'docs'), { recursive: true });
  renameSync(join(workDir, '.opencode/vault'), join(workDir, 'docs/vault'));
  writeFileSync(
    join(workDir, 'vault.config.json'),
    `${JSON.stringify({ schema_version: 1, vault_dir: 'docs/vault', src_dirs: ['src'] }, null, 2)}\n`,
    'utf8',
  );

  mkdirSync(join(workDir, 'src'), { recursive: true });
  writeFileSync(
    join(workDir, 'src', 'example.mjs'),
    'export function greet(name) {\n  return `hello ${name}`;\n}\n',
    'utf8',
  );

  const cli = join(workDir, 'scripts', 'vault.mjs');
  const runVault = (args) =>
    spawnSync(process.execPath, [cli, ...args, '--root', workDir], {
      cwd: workDir,
      encoding: 'utf8',
    });

  const idx = runVault(['index', '--json']);
  assert.equal(idx.status, EXIT_CODES.OK, `custom index stderr: ${idx.stderr}`);
  const idxData = JSON.parse(idx.stdout).data;
  assert.ok(idxData.stats.notes >= 6, `expected >= 6 notes, got ${JSON.stringify(idxData.stats)}`);
  assert.ok(idxData.path.startsWith('docs/vault/'), `index must be written under docs/vault: ${idxData.path}`);

  const chk = runVault(['check', '--strict', '--json']);
  assert.equal(chk.status, EXIT_CODES.OK, `custom check stderr: ${chk.stderr}`);

  const st = runVault(['stats', '--json']);
  assert.equal(st.status, EXIT_CODES.OK, `custom stats stderr: ${st.stderr}`);
  assert.equal(JSON.parse(st.stdout).data.index_status, 'fresh');

  const fnd = runVault(['find', '--query', 'moc-root', '--json']);
  assert.equal(fnd.status, EXIT_CODES.OK, `custom find stderr: ${fnd.stderr}`);
  assert.ok(fnd.stdout.includes('moc-root'), `expected moc-root in find output: ${fnd.stdout}`);

  const hw = runVault([
    'handoff',
    'write',
    '--run',
    'run-1',
    '--slice',
    'slice-core',
    '--status',
    'done',
    '--owner',
    'builder',
    '--body',
    '- custom layout handoff',
    '--json',
  ]);
  assert.equal(hw.status, EXIT_CODES.OK, `custom handoff stderr: ${hw.stderr}`);
  assert.ok(
    existsSync(join(workDir, 'docs/vault/90-handoffs/run-1/slice-core.handoff.md')),
    'handoff must default under the configured vault dir',
  );

  const escape = runVault(['index', '--vault-dir', '../escape', '--json']);
  assert.equal(escape.status, EXIT_CODES.VALIDATION, `expected exit 2 on traversal: ${escape.stderr}`);
});
