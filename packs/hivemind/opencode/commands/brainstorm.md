---
description: Turn a raw thought dump into .opencode/SPEC.md via @spec-architect (vault-first gate, smarter architect tier, contracts, ownership matrix, verification), then offer to launch /swarm on it.
agent: hivemind-architect
---

Raw thought dump (verbatim):
$ARGUMENTS

## 0. Pre-Exploration Vault & Model-Tier Gate (MANDATORY BEFORE ANY FILE EXPLORATION)
1. If the dump above is empty, ask the user for their thought dump and stop.
2. **Verify and resolve the higher-tier `@spec-architect` model** (strictly above worker/`builder` tier: `tier(spec-architect) >= tier(builder) + 1`):
   - Run `node scripts/hive/model-tier.mjs resolve --role spec-architect --profile <active-stack> --json` (or `~/.config/hivemind/scripts/hive/model-tier.mjs` in installed consumer projects).
   - Never pass a worker-tier model override when spawning `@spec-architect`; if an override violates `tier(spec-architect) >= tier(builder) + 1`, refuse with `tier_violation`.
3. **Check whether an Obsidian Context Vault exists before exploring project files**:
   - Run `node scripts/hive/vault-lifecycle.mjs detect --json` (fallback: `~/.config/hivemind/scripts/hive/vault-lifecycle.mjs detect --json`, or stat `.opencode/vault/00-MOC.md` and `scripts/vault.mjs`).
   - Emit `vault-gate: <state>` (`absent | partial | present_healthy | present_unhealthy`) before reading or listing any repository files.
   - **If `present_healthy` or `present_unhealthy`**: run `node scripts/vault.mjs index` and `node scripts/vault.mjs check --strict` (retry `index` once on exit `4`), read `.opencode/vault/00-MOC.md` (`[[moc-root]]`), run up to 3 L1 briefs (`node scripts/vault.mjs brief --task <id> --budget 1200`), and pass `vault-gate: <state>` plus the verbatim L0/L1 vault briefs into `@spec-architect` so it uses `find`/`slice` instead of blind directory scans.
   - **If `absent` or `partial`**: pass `vault-gate: <state>` to `@spec-architect` and allow normal Hivemind recon. Never create a vault mid-brainstorm.

## 1. Compile Spec via `@spec-architect`
1. Make ONE foreground call to `@spec-architect` on its resolved higher-tier model, passing the dump above VERBATIM (unedited, not summarized, not reordered) together with `vault-gate: <state>` and any L0/L1 vault briefs from §0. Instruct it to compile `.opencode/SPEC.md` with sections: Goal & Non-Goals, Shared Data/API Contracts, Disjoint Parallel Builder Workstreams (File Ownership Matrix), Verification Criteria, Open Questions / Assumptions.
2. You must NOT write `.opencode/SPEC.md` yourself and must NOT start implementing before user confirmation.
3. When `@spec-architect` returns, print a compact summary:
   - spec path (`.opencode/SPEC.md`)
   - `vault-gate` state and resolved `spec-architect` model tier
   - contract files
   - one line per workstream (builder # -> owned files)
   - open questions
4. If any open question changes contracts, ask those first and wait for answers (relay them to `@spec-architect` to update the spec if needed) before offering launch.
5. Then ask: "Launch /swarm on .opencode/SPEC.md now? (yes / edit first)"
   - `yes` -> proceed as `/swarm` would using `.opencode/SPEC.md` (Wave 1 contracts -> Wave 2 parallel builders -> Wave 3 verification gate -> terminal `post-goal-checkpoint` prompt via `node scripts/hive/vault-lifecycle.mjs plan --goal <goal_id> --json` and the `question` tool).
   - `edit first` -> stop and wait for the user.
6. If the user declines implementation and considers the compiled spec goal complete, run the terminal `post-goal-checkpoint` protocol after reporting the spec's validation result; call `question` with `{ questions: [plan().data.question] }`. If implementation proceeds, defer the checkpoint to `/swarm` completion. Reuse the same goal ID to avoid duplicate prompts.
