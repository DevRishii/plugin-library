# PATH-MAP — `DevRishii/plugin-library` Resolved Paths

## Recon findings

Wave 0 (`slice-recon-contracts`) inspected `DevRishii/plugin-library` on default branch `main` (commit `24037a2`) and confirmed:

- Repository layout splits installable DSH plugins under `plugins/*` and the cross-app OpenCode Hivemind pack under `packs/hivemind/`.
- Baseline hygiene check `node scripts/verify.mjs` passed (`9 plugins, 178 files, OK`, exit `0`). Note: `scripts/verify.mjs` rejects any committed file containing personal Windows user paths (`<Drive>:\Users\<name>\`), secrets, `.dsh/`, `.log`, or `.bak`.
- Baseline plugin test suite `node scripts/test-all.mjs` passed (`4 passed, 0 failed, 5 skipped`, exit `0`). `test-all.mjs` iterates `plugins/*` only, so `tests/hive/*.test.mjs` runs standalone via `node --test tests/hive/*.test.mjs` (and is wired into `package.json` scripts in Wave 3).
- Both `packs/hivemind/hive-switch.ps1` and `packs/hivemind/bin/hive-switch` require a `model:` key in the YAML frontmatter of `packs/hivemind/opencode/agents/*.md` so stack switches can patch it in place. Therefore agent default frontmatter keeps valid baseline `model:` lines while `model-tier.mjs verify` enforces `tier(spec-architect) >= tier(builder) + 1` across both every profile JSON and the baseline agent frontmatter.

## Assumed path -> actual path deviation table

| Alias | Assumed candidate | Resolved actual path |
|---|---|---|
| `brainstorm_command` | `.opencode/commands/brainstorm.md` | `packs/hivemind/opencode/commands/brainstorm.md` |
| `swarm_command` | `.opencode/commands/swarm.md` | `packs/hivemind/opencode/commands/swarm.md` |
| `spec_architect_agent` | `.opencode/agents/spec-architect.md` | `packs/hivemind/opencode/agents/spec-architect.md` |
| `agent_definitions` | `.opencode/agents/*.md` | `packs/hivemind/opencode/agents/{auditor,builder,hivemind-architect,oracle,researcher,scout,spec-architect,surgeon,verifier}.md` |
| `profile_configs` | `profiles/*.json` | `packs/hivemind/profiles/{argon-deepseek,chatgpt-deepseek,claude-hybrid,claude-native,opencode-go-max}.json` |
| `stack_configs` | `stacks/*.json` | `packs/hivemind/opencode/commands/stack/{argon-deepseek,chatgpt-deepseek,claude-hybrid,claude-native,opencode-go-max}.md` |
| `hive_switch_entry` | `scripts/hive-switch.mjs` | `packs/hivemind/hive-switch.ps1` (Windows) + `packs/hivemind/bin/hive-switch` (POSIX) |
| `root_agents` | `AGENTS.md` | `packs/hivemind/opencode/AGENTS.md` |
| `package_json` | `package.json` | `package.json` |
| `commands.lint` | `<resolved>` | `node scripts/verify.mjs` |
| `commands.test` | `<resolved>` | `node scripts/test-all.mjs` |
| `commands.install` | `<resolved>` | `node scripts/link-profile.mjs --dry-run` |
