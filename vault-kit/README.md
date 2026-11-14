# Vault Kit (1.0.0)

A portable, zero-dependency context vault: pointer notes plus a single Node CLI
(`scripts/vault.mjs`) that keeps an index, serves bounded briefs, slices symbols,
and stores run handoff digests. Copy `template/` into any repository, substitute
the closed placeholder set, and the vault is ready to index.

## Layout

```text
vault-kit/
  VERSION                       kit version (copied into consumer repos)
  _schema/                      canonical JSON schemas (locked contracts)
    frontmatter.schema.json     note frontmatter contract
    index.schema.json           generated context index contract
    handoff.schema.json         run handoff note contract
  prompts/                      reusable agent prompts (gate, checkpoint, librarian, handoff)
  template/                     verbatim payload copied into a consumer repo
    AGENTS.vault-snippet.md     idempotent AGENTS.md block
    .opencode/
      agents/context-librarian.md
      commands/{vault-brief,vault-refresh,vault-init}.md
      skills/context-vault/SKILL.md
      vault/
        00-MOC.md               L0 entry note (`moc-root`, <= 400 est. tokens)
        10-map/{map-repo,map-layers}.md
        40-runbooks/{runbook-swarm-run,runbook-handoff,runbook-context-budget}.md
        90-handoffs/            runtime digests, one directory per run id
        _schema/                note-ids.json plus the three locked schemas
    scripts/
      vault.mjs                 CLI entry point
      vault/                    command, indexer, validator, and render modules
  README.md                     this file
```

## Placeholders

Template files carry only these tokens. Substitution happens once, at copy time;
no other brace token is allowed anywhere under `template/`.

| Token | Value |
| --- | --- |
| `{{PROJECT_NAME}}` | repository or product name |
| `{{PROJECT_ONE_LINER}}` | one sentence describing the project |
| `{{STACK}}` | runtime and language summary |
| `{{SRC_DIRS}}` | source roots scanned for the index, comma separated |
| `{{TEST_CMD}}` | the project's acceptance or test command |
| `{{VAULT_DIR}}` | vault directory, default `.opencode/vault` |
| `{{DATE}}` | ISO date of scaffolding, `YYYY-MM-DD` |

Every other file under `template/` is already final: no unresolved tokens, no
project-specific names, no absolute paths.

## CLI

```text
node scripts/vault.mjs index [--check]
node scripts/vault.mjs brief --task <id> [--budget 1200] [--json]
node scripts/vault.mjs find --query <text> [--limit 8] [--type <t>] [--path <glob>]
node scripts/vault.mjs slice --file <path> [--symbol <name>] [--context 2]
node scripts/vault.mjs handoff write --run <id> --slice <id> --status <status> [--runs-dir <dir>]
node scripts/vault.mjs handoff list --run <id> [--runs-dir <dir>] [--json]
node scripts/vault.mjs check [--strict] [--json]
node scripts/vault.mjs stats [--json]
```

Global flags: `--root <dir>`, `--json`, `--quiet`, `--help`.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | ok |
| `1` | internal error |
| `2` | validation or budget failure (bad frontmatter, oversized brief, invalid flag) |
| `3` | not found or refused (unknown id, missing run, immutable `done` handoff) |
| `4` | stale or missing index (run `index` once, then retry) |

`check --strict` exit `4` means the index no longer matches the working tree.
`handoff write` refuses to overwrite a digest whose status is `done` and exits `3`.

## Generalization guarantees

- Zero runtime dependencies; Node 22+ ESM only, no network, no telemetry.
- No authoring-project coupling: no product names, private schemas, ticket ids,
  absolute paths, or machine-specific configuration in `template/` or this README.
- Paths are repository-relative and validated against the resolved root, so
  symlinks or `..` segments cannot escape the vault.
- Deterministic output: notes are LF-only UTF-8, the index is sorted, and the
  same tree always produces the same `source_hash`.
- Budgets are enforced by the CLI, not by convention: 400 estimated tokens for
  the MOC and handoff bodies, 1200 for briefs, 120 lines per slice, 5 bullets per
  digest, 2 MB per scanned file.
- The AGENTS.md block is idempotent: spliced between
  `<!-- context-vault:begin -->` and `<!-- context-vault:end -->`, re-running the
  installer replaces the block instead of duplicating it.
- The template is self-validating: after substitution, `index` then
  `check --strict` must both exit `0` against the shipped notes.