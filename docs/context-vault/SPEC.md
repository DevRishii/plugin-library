# Hivemind x Obsidian Context Vault — `DevRishii/plugin-library` Delivery Specification

Status: **CONTRACTS LOCKED (Wave 0 complete)**.
Repository: `DevRishii/plugin-library` (`default_branch: main`, feature branch `feat/context-vault-checkpoints`).

## 0. Goal & Non-Goals

### Goal
1. Ship a single pull request to `DevRishii/plugin-library` with a clear title (`docs/context-vault/PR-TITLE.txt`) and body (`docs/context-vault/PR-BODY.md`) containing `## Problem Statement` and `## Solution`.
2. After Hivemind completes a goal and passes its verification gate, if no Obsidian context vault exists in the project, prompt the user via the `question` tool (`Yes` / `No`) to checkpoint the repository into one; on `Yes`, scaffold `.opencode/vault/` + `scripts/vault.mjs` and verify (`index` + `check --strict` exit `0`).
3. Modify `/brainstorm` (`packs/hivemind/opencode/commands/brainstorm.md`) and `spec-architect` (`packs/hivemind/opencode/agents/spec-architect.md`) so they detect an existing Obsidian context vault before any project file exploration and follow L0–L2 progressive disclosure when present.
4. When an Obsidian context vault already exists in the project, prompt the user (`question` tool, `Yes` / `No`) after each completed Hivemind goal to refresh drifted vault notes and re-verify (`index` + `check --strict`).
5. Enforce across all Hivemind stacks/profiles, `hive-switch`, and `/brainstorm` that `spec-architect` always uses a strictly higher/smarter model tier than `builder` (`tier(spec-architect) >= tier(builder) + 1`).

### Non-Goals
- No external npm dependencies or lockfile changes.
- No network I/O inside vault or model-tier CLIs.
- No vault creation mid-`/brainstorm` (creation occurs post-completion only).

## 1. Shared Data/API Contracts

### 1.1 C0 — `docs/context-vault/PATH-MAP.json`
Maps every repository alias (`brainstorm_command`, `swarm_command`, `spec_architect_agent`, `agent_definitions`, `profile_configs`, `stack_configs`, `hive_switch_entry`, `hive_switch_posix`, `install_ps1`, `install_sh`, `root_agents`, `package_json`) and repository commands (`lint: node scripts/verify.mjs`, `test: node scripts/test-all.mjs`).

### 1.2 C1 — Vault Detection (`scripts/hive/vault-detect.mjs`)
- Sentinels: `.opencode/vault/00-MOC.md` and `scripts/vault.mjs` (overridable via `vault.config.json` with `schema_version: 1` or `--vault-dir`).
- States: `absent` | `partial` | `present_healthy` | `present_unhealthy`.
- Read-only, deterministic, offline; exits `0` for all resolved states, `2` on invalid config/traversal, `3` on missing `--root`.

### 1.3 C2 & C3 — Portable Vault Kit (`vault-kit/`) & CLI (`scripts/vault.mjs`)
- Closed placeholder set: `{{PROJECT_NAME}}`, `{{PROJECT_ONE_LINER}}`, `{{STACK}}`, `{{SRC_DIRS}}`, `{{TEST_CMD}}`, `{{VAULT_DIR}}`, `{{DATE}}`.
- Zero authoring-project coupling (no project-specific names, schemas, or paths).
- Required note IDs: `moc-root`, `map-repo`, `map-layers`, `runbook-swarm-run`, `runbook-handoff`, `runbook-context-budget`, plus derived `20-contracts/contract-*.md` and `30-slices/slice-*.md`, and `.opencode/vault/90-handoffs/` (`--runs-dir` override supported).
- CLI commands: `index`, `brief`, `find`, `slice`, `handoff write|list`, `check [--strict]`, `stats` with exit codes `0` ok, `1` internal, `2` validation/budget, `3` not found/refused, `4` stale/missing index.
- Idempotent `AGENTS.md` block delimited by `<!-- context-vault:begin -->` and `<!-- context-vault:end -->`.

### 1.4 C4 & C5 — Lifecycle CLI (`scripts/hive/vault-lifecycle.mjs`) & `question` UX (`scripts/hive/vault-prompt.mjs`)
- Subcommands: `detect`, `plan`, `scaffold`, `update`, `verify`, `state get|record`.
- Flow A (`absent` / `partial`): `header: "Obsidian Context Vault"`, `options`: `Yes`, `No`. `partial` prepends `"A partial vault was found at <vault_dir> (missing: <paths>). It will be repaired, not overwritten. "`.
- Flow B (`present_healthy` / `present_unhealthy`): `header: "Refresh Context Vault"`, `options`: `Yes`, `No`.
- Anti-double-prompt state persisted in `.hive/lifecycle/<goal_id>.json` (`goal_id` matches `^[A-Za-z0-9._-]{1,64}$`). `CI` environment auto-selects `No`.

### 1.5 C6 — Vault-First Pre-Exploration Gate
- `packs/hivemind/opencode/commands/brainstorm.md` and `packs/hivemind/opencode/agents/spec-architect.md` execute model-tier resolution and `vault-lifecycle.mjs detect --json` and emit `vault-gate: <state>` before any `read`/`grep`/`glob` exploration instruction.

### 1.6 C7 — Model-Tier Hierarchy (`config/model-tiers.json` + `scripts/hive/model-tier.mjs`)
- Tiers: `1` (`cheap`), `2` (`standard`), `3` (`smart`), `4` (`frontier`).
- Invariant: `tier(spec-architect) >= tier(builder) + 1` across every profile in `packs/hivemind/profiles/*.json` and baseline agent frontmatter in `packs/hivemind/opencode/agents/*.md`.
- `hive-switch.ps1` and `packs/hivemind/bin/hive-switch` verify tier compliance when switching profiles and fail closed on violations.

## 2. Disjoint Parallel Builder Workstreams

| Slice | OWNED_FILES | READ_ONLY_CONTRACTS | Dependencies | ACCEPTANCE_CHECK |
|---|---|---|---|---|
| **W0 `slice-recon-contracts`** (architect) | `docs/context-vault/{SPEC.md,PATH-MAP.json,PATH-MAP.md,PR-PLAN.md,PR-TITLE.txt,PR-BODY.md,DECISIONS.md}`, `vault-kit/_schema/*.json`, `vault-kit/VERSION`, `scripts/hive/contracts.mjs`, `vault-kit/prompts/{pre-exploration-gate,post-goal-checkpoint}.md`, `packs/hivemind/opencode/commands/{brainstorm,swarm}.md`, `packs/hivemind/opencode/agents/spec-architect.md`, `packs/hivemind/opencode/AGENTS.md`, `.gitignore` | reference vault schema & CLI semantics | none | `node scripts/hive/contracts.mjs --self-check` -> 0 |
| **W1 `slice-vault-kit-template`** | `vault-kit/template/**`, `vault-kit/README.md`, `tests/hive/vault-kit-template.test.mjs`, `tests/fixtures/vault-kit/**` | `vault-kit/_schema/*.json`, `scripts/hive/contracts.mjs`, `vault-kit/VERSION`, `docs/context-vault/SPEC.md` | W0 | `node --test tests/hive/vault-kit-template.test.mjs` -> 0 |
| **W1 `slice-vault-detect`** | `scripts/hive/vault-detect.mjs`, `tests/hive/vault-detect.test.mjs`, `tests/fixtures/vault-detect/**` | `scripts/hive/contracts.mjs`, `docs/context-vault/SPEC.md` | W0 | `node --test tests/hive/vault-detect.test.mjs` -> 0 |
| **W1 `slice-model-tiers`** | `config/model-tiers.json`, `scripts/hive/model-tier.mjs`, `tests/hive/model-tier.test.mjs`, `tests/fixtures/model-tiers/**`, `packs/hivemind/profiles/*.json`, `packs/hivemind/hive-switch.ps1`, `packs/hivemind/bin/hive-switch`, `packs/hivemind/install.ps1`, `packs/hivemind/install.sh` | `scripts/hive/contracts.mjs`, `docs/context-vault/PATH-MAP.json`, `packs/hivemind/opencode/agents/*.md`, `docs/context-vault/SPEC.md` | W0 | `node --test tests/hive/model-tier.test.mjs` -> 0 && `node scripts/hive/model-tier.mjs verify --strict --json` -> 0 |
| **W1 `slice-prompt-contract`** | `vault-kit/prompts/{librarian-refresh,handoff-rules}.md`, `tests/hive/prompt-contract.test.mjs`, `tests/fixtures/prompts/**` | `packs/hivemind/opencode/commands/{brainstorm,swarm}.md`, `packs/hivemind/opencode/agents/spec-architect.md`, `packs/hivemind/opencode/AGENTS.md`, `vault-kit/prompts/{pre-exploration-gate,post-goal-checkpoint}.md` | W0 | `node --test tests/hive/prompt-contract.test.mjs` -> 0 |
| **W1 `slice-vault-prompt`** | `scripts/hive/vault-prompt.mjs`, `tests/hive/vault-prompt.test.mjs`, `tests/fixtures/vault-prompt/**` | `scripts/hive/contracts.mjs`, `docs/context-vault/SPEC.md` | W0 | `node --test tests/hive/vault-prompt.test.mjs` -> 0 |
| **W2 `slice-vault-lifecycle`** | `scripts/hive/vault-lifecycle.mjs`, `tests/hive/vault-lifecycle.test.mjs`, `tests/fixtures/vault-lifecycle/**` | `vault-kit/template/**`, `scripts/hive/{contracts,vault-detect,vault-prompt}.mjs`, `vault-kit/_schema/*.json` | W1 | `node --test tests/hive/vault-lifecycle.test.mjs` -> 0 |
| **W2 `slice-docs`** | `docs/context-vault/{GUIDE,USAGE}.md`, `README.md`, `packs/hivemind/README.md` | `docs/context-vault/{SPEC,PATH-MAP,DECISIONS}.md`, `vault-kit/README.md` | W0 | `node scripts/verify.mjs` -> 0 |
| **W2 `slice-e2e-checkpoints`** | `tests/hive/{e2e-checkpoint,e2e-tier}.test.mjs`, `tests/fixtures/e2e/**`, `scripts/hive/e2e-fixtures.mjs` | all W0 + W1 + W2 lifecycle artifacts | W2 lifecycle, W1 | `node --test tests/hive/e2e-checkpoint.test.mjs tests/hive/e2e-tier.test.mjs` -> 0 |
| **W3 `slice-release-pr`** (architect) | `package.json`, `docs/context-vault/RELEASE.md` | all artifacts above | `@verifier` + `@auditor` clean | full §3 gate + PR creation |

## 3. Verification Criteria

- `node scripts/hive/model-tier.mjs verify --strict --json` exits `0` (`violations: []`).
- `node --test tests/hive/*.test.mjs` exits `0`.
- `node scripts/verify.mjs` exits `0` (zero personal paths, secrets, or plugin regressions).
- `node scripts/test-all.mjs` exits `0` (all existing plugin suites pass).
- Pull request created (or patch emitted under unauthenticated fallback) with `## Problem Statement` and `## Solution`.
