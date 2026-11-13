# Fleet mode (agent preset bundle)

A DSH agent preset that runs like `standard` but is built around orchestration:
it turns each prompt into a delegation brief, fans the work out across
subagents with tiered models, verifies their claims, and synthesizes one
answer on a token budget.

Installed as the local profile bundle `@local/fleet-preset`, so it appears in
the Web mode/agent-preset picker as **Fleet**.

## What it does

1. **Sharpens the prompt** into a brief: goal, deliverables and acceptance
   criteria, constraints, and independent work units with disjoint write
   scopes. Vague requests are rewritten into testable instructions.
2. **Sizes the swarm** and picks the instrument: the `workflow` tool for 3+
   independent units or structured merges, `subagent`/`subagent_fork` for one
   or two delegations, Agent Teams for durable shared-tree collaboration.
3. **Routes models** to save credits: bulk, mechanical, and research units go
   to `deepseek-flash` (usually `low`/`off` effort); `deepseek-v4-pro` with
   `high`/`max` is reserved for hard reasoning, adjudication, and synthesis.
4. **Verifies before trusting** child output, then **synthesizes once** with
   paths and evidence instead of pasting raw reports.

The compact contract lives in the preset persona; the full playbook
(brief template, budget tiers, workflow-script patterns, team playbook,
anti-waste checklist) is the `fleet-orchestration` skill, loaded on demand so
other modes never pay for it.

## Files

- `cordis.patch.yml` — the `preset-fleet` declaration (tool set mirrors
  `preset-standard`; the delegation group adds child model routing and caps).
- `skills/fleet-orchestration/SKILL.md` — the orchestration playbook.
- `package.json` — bundle manifest (`dsh.bundle.patch`).

## Tuning

- **Capabilities / tool set**: edit the `plugins:` list in
  `cordis.patch.yml`. Keep row ids aligned with `preset-standard` so the two
  modes stay comparable.
- **Playbook**: edit `skills/fleet-orchestration/SKILL.md` (changes are picked
  up by the skill watcher for new turns).
- **Fan-out ceiling**: `maxConcurrentAgents: 10` in the `workflow-ptc` row
  matches the profile-wide subagent capacity (10) set in
  `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`; raise both together
  or extra starts fail with `ACTIVATION_LIMIT_REACHED`. `maxTotalAgents: 96`
  is the per-workflow-run ceiling.
- **Agent Teams size**: the experimental Agent Teams bundle caps members at 8
  in the same profile patch (`agent-team.maxMembers`).

After editing this bundle's patch, reinstall it (Settings → Plugins, or
`dsh plugin --profile desktop add <path>`) and start a new session: existing
sessions keep the preset revision they started with.

## Install verification

Installed and verified on this profile: the `preset-fleet` declaration mounts
with no broken rows (all 26 enabled plugin rows active; 22 declared entries
with groups flattened), and the `fleet-orchestration` skill is advertised only
in Fleet sessions — the other presets' catalogs stay unchanged.
