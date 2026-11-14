# Context Vault Operator Guide

> The lifecycle CLI and scaffolded project CLI have unit and end-to-end coverage.
> Run the checks in [`USAGE.md`](USAGE.md) and report observed exit codes.

The context vault is an optional, Obsidian-compatible set of pointer notes at
`.opencode/vault/` plus a zero-dependency Node CLI copied into the project as
`scripts/vault.mjs`. It gives agents progressive disclosure instead of blind
repository scans:

| Layer | Content | Budget |
| --- | --- | --- |
| L0 | `00-MOC.md` map of content | 400 estimated tokens |
| L1 | `brief` notes for a task | 1,200 estimated tokens |
| L2 | `find` / `slice` path and symbol pointers | 120 lines per slice |
| L3 | `90-handoffs/<run>/<slice>.handoff.md` digests | 5 bullets / 400 tokens |

No network I/O, no runtime dependencies, no telemetry. The vault is project-local;
it is created only after a goal completes, never during `/brainstorm`.

## Consent: create, update, or no

After a Hivemind goal completes **and** the verification gate passes with zero
blockers, the orchestrator runs `vault-lifecycle.mjs plan --goal <goal_id> --json`
once and, if an action is returned, asks exactly one `question` with the returned
payload verbatim. The labels are always exactly `Yes` and `No`.

| Vault state | Action | Prompt header | `Yes` does |
| --- | --- | --- | --- |
| `absent` | `prompt_create` | `Obsidian Context Vault` | Scaffolds the vault, indexes, requires `check --strict` to exit `0` |
| `partial` | `prompt_create` | `Obsidian Context Vault` | Repairs missing required notes, then indexes and checks |
| `present_healthy` | `prompt_update` | `Refresh Context Vault` | Refreshes drifted pointer notes, re-indexes, and checks |
| `present_unhealthy` | `prompt_update` | `Refresh Context Vault` | Refreshes/re-derives, re-indexes, and checks |

- A `partial` prompt is prefixed with a notice that a partial vault was found,
  which paths are missing, and that it will be repaired, **not overwritten**.
- `No` (or dismissing the prompt) writes nothing under `.opencode/vault/` and
  never creates or edits `scripts/vault.mjs`. It is a clean completion, not an
  error. The answer is recorded so the same goal is not prompted twice.
- In CI (`CI` set to anything except empty/`0`/`false`), consent auto-selects
  `No` and no prompt is shown.
- Per-goal state lives in `.hive/lifecycle/<goal_id>.json`; `goal_id` must match
  `^[A-Za-z0-9._-]{1,64}$`. The directory is git-ignored.
- Vault creation or repair happens **only** after completion. A `/brainstorm`
  that finds no vault proceeds with normal recon and must not scaffold one.

## Vault-first exploration

Before any `read`, `grep`, `glob`, directory listing, or source inspection, the
exploration gate does this in order:

1. Resolve and verify the `spec-architect` model tier.
2. Run `vault-lifecycle.mjs detect --json` (read-only).
3. Emit `vault-gate: <state>` into the run context, where state is one of
   `absent`, `partial`, `present_healthy`, `present_unhealthy`.
4. Branch:

- **Vault present** (`present_healthy` or `present_unhealthy`): run
  `node scripts/vault.mjs index`, then `check --strict` (on exit `4`, run
  `index` once and retry). Read L0 `00-MOC.md` (`[[moc-root]]`), then up to three
  L1 briefs and `find` / `slice` queries. Stay within 1,600 estimated tokens
  before source inspection. Fall back to targeted reads only for paths the vault
  did not index, and state which query returned zero rows. Broad recursive scans
  are forbidden unless `find` returned zero rows and the reason is recorded.
- **Vault absent or partial**: use normal Hivemind recon. Do not create a vault.

If the project CLI fails with an exit code other than `4`, report the typed
error and continue with the vault as degraded, read-only context rather than
silently rescanning everything.

## Smarter architect invariant

Model tiers are `1` cheap, `2` standard, `3` smart, `4` frontier. Across every
stack/profile, baseline agent frontmatter, and `/brainstorm` spawn:

```text
tier(spec-architect) >= tier(builder) + 1
```

`model-tier.mjs verify --strict --json` checks every profile and baseline agent
definition. `hive-switch` fails closed when a target profile violates the
invariant. Never pass a worker-tier model override to `@spec-architect`; a
violating override is refused with `tier_violation`.

## Install and upgrade

Installers copy the Hive scripts and contracts into the user config so consumer
projects can invoke them:

```text
~/.config/hivemind/scripts/hive/*.mjs        lifecycle, detect, model-tier, contracts
~/.config/hivemind/vault-kit/                template and schemas used by scaffold
~/.config/hivemind/config/model-tiers.json   tier definitions
```

OpenCode prompts (`AGENTS.md`, agents, commands, skills) are also installed.
**Existing prompt files are kept by default.** To explicitly refresh them after
an upgrade, pass the force flag:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Force
```

```bash
FORCE=1 bash install.sh
```

Without the force flag, an upgrade leaves old prompts in place, so new commands
or gate language may not appear. With the force flag, bundled prompts overwrite
the installed ones — back up local customizations first. Existing profiles and
`opencode.json` are backed up as `*.bak.<timestamp>`; `opencode.json` is only
rewritten when a stack is activated. The installer never edits a project's
existing `.opencode/vault/`.

## Installed CLI versus local scripts

| Location | Purpose | When to use |
| --- | --- | --- |
| `scripts/hive/*.mjs` in a checkout | Development copy of Hive CLIs | Inside this library checkout |
| `~/.config/hivemind/scripts/hive/*.mjs` | Installed Hive CLIs | Consumer projects without local `scripts/hive/` |
| `scripts/vault.mjs` in a project | Project vault CLI created by scaffold | Every `index` / `brief` / `find` / `slice` / `handoff` / `check` call |
| `~/.config/hivemind/vault-kit/` | Template source used to create the project vault | Scaffold/update, not direct querying |

Prefer a local `scripts/hive/` when present; otherwise use the installed path.
`~/.config/hivemind/vault-kit/` is not a vault — do not query it as one. The
project's `scripts/vault.mjs` is a substituted copy, so upgrades do not rewrite
it silently; use the consent-gated `update` path to refresh generated notes.

## Health, exit codes, limits

States reported by detection:

- `absent` — neither sentinel exists.
- `partial` — one sentinel or required note is missing.
- `present_healthy` — sentinels exist and the project CLI reports a clean
  structure/freshness check.
- `present_unhealthy` — sentinels exist but the check fails.

Sentinels are `.opencode/vault/00-MOC.md` and `scripts/vault.mjs`, overridable by
`vault.config.json` (`schema_version: 1`, optional `vault_dir` / `scripts_dir`)
or `--vault-dir`. Detection is read-only, deterministic, and offline; it exits
`0` for every resolved state, `2` for invalid config or traversal, and `3` for a
missing `--root`.

Shared vault CLI exit codes:

| Code | Meaning |
| --- | --- |
| `0` | ok |
| `1` | internal error |
| `2` | validation or budget failure (bad frontmatter/flag/config, oversized brief, over-cap digest) |
| `3` | not found or refused (unknown id/run, immutable `done` handoff overwrite) |
| `4` | stale or missing index — run `index` once, then retry |

`check --strict` exit `4` means the index no longer matches the working tree; it
does not by itself mean note content is semantically wrong.

Limits to keep in mind:

- `check` validates structure, links, budgets, and index freshness — not whether
  prose is accurate or complete.
- Hard caps: 400-token MOC, 1,200-token briefs, 1,600-token pre-exploration,
  400-token / 5-bullet handoffs, 120-line slices, 2 MB per scanned file, and an
  index symbol cap. Rejected oversized input must be trimmed, not retried as-is.
- Paths are root-contained; `..` segments and escaping symlinks are refused.
- Handoff writing is not a secret scanner. Never place diffs, logs, tokens, or
  credentials in vault notes or digests.
- Vault tooling performs no network calls; external fetches remain the agent's
  responsibility under its own permissions.

## Related contracts

- [`SPEC.md`](SPEC.md) — locked delivery specification and ownership matrix.
- [`PATH-MAP.json`](PATH-MAP.json) — resolved repository paths and commands.
- [`DECISIONS.md`](DECISIONS.md) — decisions and deviations.
- [`../../vault-kit/README.md`](../../vault-kit/README.md) — template, schemas,
  placeholders, and full CLI surface.
- [`../../vault-kit/prompts/pre-exploration-gate.md`](../../vault-kit/prompts/pre-exploration-gate.md)
  and [`post-goal-checkpoint.md`](../../vault-kit/prompts/post-goal-checkpoint.md)
  — verbatim gate and checkpoint prompts.
