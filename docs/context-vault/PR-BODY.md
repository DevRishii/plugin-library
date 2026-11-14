## Problem Statement

Hivemind runs pay for repository context twice: the orchestrator explores the repository to understand the task, and every downstream subagent re-explores because its briefing is prose rather than bounded symbol pointers. Three concrete gaps follow:

1. **No Obsidian context vault awareness in `/brainstorm`.** `/brainstorm` and `spec-architect` start by scanning project files directly. When a project already contains an Obsidian context vault (`.opencode/vault/00-MOC.md` plus a zero-dependency `scripts/vault.mjs` CLI), runs ignore that index and burn tokens on broad directory scans and whole-file reads instead of L0–L2 progressive disclosure (`brief`, `find`, `slice`). When a project has no vault, nothing offers to checkpoint the repository into one after a goal succeeds.
2. **No post-completion vault checkpoint or refresh lifecycle.** After Hivemind finishes a goal, repository files change and any existing vault drifts silently. Users are never prompted via the `question` tool (`Yes` / `No`) to create an Obsidian context vault after a first completion or to update an existing vault with the latest changes, nor is strict validation (`index` + `check --strict`) enforced when they opt in.
3. **Architect vs. worker model-tier risk.** During `/brainstorm` and profile switches, `spec-architect` is the high-leverage architectural compiler, yet nothing programmatically enforces that `spec-architect` always resolves to a strictly higher/smarter model tier than worker `builder` subagents across every Hivemind stack and profile.

## Solution

- **Portable Obsidian Context Vault Kit (`vault-kit/`).** Ships a project-agnostic template (`00-MOC.md`, `10-map/`, `20-contracts/`, `30-slices/`, `40-runbooks/`, `90-handoffs/`, `_schema/`), the zero-dependency `scripts/vault.mjs` CLI (`index`, `brief`, `find`, `slice`, `handoff`, `check --strict`, `stats` with exit codes `0..4`), a `context-librarian` agent, `/vault-init`, `/vault-brief`, `/vault-refresh` commands, a `context-vault` skill, and idempotent `AGENTS.md` marker blocks.
- **Executable Vault Lifecycle & Question Payloads (`scripts/hive/`).** `vault-detect.mjs`, `vault-prompt.mjs`, and `vault-lifecycle.mjs` (`detect | plan | scaffold | update | verify | state`) implement a deterministic four-state machine (`absent`, `partial`, `present_healthy`, `present_unhealthy`) and emit exact `question` tool payloads (`Yes` / `No`) with per-goal idempotency in `.hive/lifecycle/<goal>.json` and CI auto-`No` handling.
- **Pre-Exploration Vault Gate in `/brainstorm` and `spec-architect`.** Both `packs/hivemind/opencode/commands/brainstorm.md` and `packs/hivemind/opencode/agents/spec-architect.md` run `vault-lifecycle.mjs detect --json` and emit `vault-gate: <state>` before any file exploration. When a vault exists, they run `index` -> `check --strict` -> L0 `00-MOC.md` -> `brief`/`find`/`slice` before any targeted fallback read; when absent, normal exploration runs without creating a vault mid-brainstorm.
- **Post-Goal Checkpoint & Refresh Prompts.** After Hivemind completes a goal and passes its quality gate (`packs/hivemind/opencode/commands/swarm.md` and `/brainstorm` completion flow), `vault-lifecycle.mjs plan` determines whether to prompt first-time vault creation (`Obsidian Context Vault`, `Yes`/`No`) or existing-vault refresh (`Refresh Context Vault`, `Yes`/`No`). Selecting `Yes` scaffolds or refreshes drifted pointers and requires `index` + `check --strict` exit `0`; selecting `No` leaves the repository untouched.
- **Enforced Smarter Architect Model Tier (`config/model-tiers.json` + `scripts/hive/model-tier.mjs`).** Defines explicit capability tiers (`1` cheap -> `4` frontier) for every Hivemind model and enforces `tier(spec-architect) >= tier(builder) + 1` across all profiles, baseline agent frontmatter, `/brainstorm` spawns, and `hive-switch` (`hive-switch.ps1` and `bin/hive-switch`), failing closed on unknown models or tier violations.

## What Changed

- `vault-kit/**` — generalized vault template, JSON schemas, `scripts/vault.mjs` CLI modules, and reusable prompt gate/checkpoint blocks
- `scripts/hive/{contracts,vault-detect,vault-prompt,vault-lifecycle,model-tier,e2e-fixtures}.mjs` — lifecycle, detection, prompt builder, and model-tier verification CLIs
- `config/model-tiers.json` — canonical model tier registry and role invariants
- `packs/hivemind/**` — vault-first `/brainstorm` and `spec-architect`, post-goal checkpoint in `/swarm`, constitution rules in `opencode/AGENTS.md`, tier verification guard in `hive-switch.ps1` and `bin/hive-switch`, and kit installation in `install.ps1` and `install.sh`
- `tests/hive/**`, `tests/fixtures/**`, `docs/context-vault/**`, `README.md`, `package.json`, `.gitignore`

## How It Was Verified

- `node scripts/hive/model-tier.mjs verify --strict --json` — exits `0` across all 5 Hivemind profiles (`violations: []`), and exits `2` (`tier_violation`) against negative fixtures.
- `node --test tests/hive/*.test.mjs` — unit and end-to-end suites covering kit generalization, four-state vault detection, `question` snapshot payloads (`Yes`/`No` + partial + CI auto-`No`), scaffold/update/idempotency lifecycle, prompt ordering contracts, and model-tier enforcement.
- `node scripts/verify.mjs` and `node scripts/test-all.mjs` — repository structural hygiene and all existing plugin test suites pass with zero regressions and zero new dependencies.
