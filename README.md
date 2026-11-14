# Plugin Library

Private library of desktop-agent plugins, mods, and agent presets. It started
as a DeepSeek Harness (DSH) plugin collection — the idea board, dream board,
nightmare board, session cost, and friends — and is organized so the reusable
cores can be bound to other desktop agent apps as well.

No secrets, session logs, or board data live here. Everything under `plugins/`
is a self-contained package; `docs/porting.md` explains what each one needs from
a host.

## Catalog

| Package | Version | What it does | Surface |
| --- | --- | --- | --- |
| [`idea-board`](plugins/idea-board) | 1.4.0 | Ideas, dreams, and nightmares in one dockable board; runs the Dreamer, generates build packets, and tracks doctor defects | Floating overlay + sidebar footer + `/dream`, `/dreamer` |
| [`turn-cost`](plugins/turn-cost) | 1.3.1 | Estimated session API cost, priced per token bucket with a refreshable per-model breakdown | Composer statistics row |
| [`session-diff`](plugins/session-diff) | 1.0.0 | Deterministic session receipt: files with before/after SHA-256, commands with exit codes, per-turn cost, open threads; snapshots and restore | Right-sidebar Receipt tab + `receipt` tool + `dsh-receipt` CLI |
| [`fleet-preset`](plugins/fleet-preset) | 1.0.0 | Fleet mode: orchestration-first persona, five-step loop, tiered model routing, the fleet playbook skill | Agent/mode picker |
| [`fleet-view`](plugins/fleet-view) | 1.0.0 | Live subagent tree with status, duration, tokens, model, and estimated swarm cost | Right-sidebar Fleet tab |
| [`session-tripwire`](plugins/session-tripwire) | 0.1.0 | Workspace write-intent ledger: leases, fences, warn-or-block on concurrent writes, live board | Tool hook + `/tripwire` + HTML board |
| [`dsh-doctor`](plugins/dsh-doctor) | 0.1.0 | Deterministic preflight checks for a harness workspace; JSON/`--nightmares` feed, history, explain, dry-run fixes | Standalone CLI |
| [`theme-engine`](plugins/theme-engine) | 1.0.0 | Eight preset palettes layered over light/dark through theme token overrides | Settings row |
| [`restart-app`](plugins/restart-app) | 1.0.0 | Restart the desktop app from the composer so installed plugin changes load | Composer button + `/restart-app` |
| [`packs/hivemind`](packs/hivemind) | v2.5 | OpenCode `/stack` picker, nine agent roles, adaptive DAG `/swarm`, `/brainstorm`, token-discipline skill, five provider profiles | OpenCode pack (cross-app) |

`experiments/sidebar-vertical-split/` holds the design patch and notes for
stacking the right sidebar's two panes vertically; it is not an installable
package.

## Hivemind context vault

Hivemind can checkpoint a finished project into an optional Obsidian-compatible
context vault: pointer notes under `.opencode/vault/` plus a zero-dependency
`scripts/vault.mjs` CLI. After a goal passes verification, `/swarm` asks once
with exact `Yes` / `No` options whether to create a vault (`absent` / `partial`)
or refresh one (`present_*`); `No`, and CI, write nothing. `/brainstorm` and
`@spec-architect` always check the vault before exploring project files and emit
`vault-gate: <state>`. Every stack keeps `spec-architect` at least one model tier
above `builder`. See [`docs/context-vault/GUIDE.md`](docs/context-vault/GUIDE.md)
for consent, install/upgrade, and health semantics, and
[`docs/context-vault/USAGE.md`](docs/context-vault/USAGE.md) for recipes.

## The boards

One plugin, three tabs, three jobs:

- **Ideas** — a durable, editable list. Quick capture, done toggle, clear done.
- **Dreams** — AI-generated product dreams researched by the Dreamer preset
  (scheduled or on demand), scored on value, niche, revenue, feasibility, and
  fit. A dream can be **Pursued** into a Fleet buildout, which first renders a
  deterministic build packet with an acceptance check per MVP bullet.
- **Nightmares** — real defects found by `dsh-doctor`. Each entry carries the
  failing check, evidence paths, and the suggested fix. **Squash** launches a
  Fleet repair session; the entry closes only when an independent doctor run
  reports the check passing. **Keep** requires a reason. Nothing is repaired or
  dismissed silently.

The board writes through typed operations only (`dream_save`, `dream_retire`,
`nightmare_add`, `nightmare_decide`, …); the Dreamer preset has no shell or
file-write tool. See [`plugins/idea-board/DREAM-BOARD.md`](plugins/idea-board/DREAM-BOARD.md)
for the schemas, caps, rubric, and schedule.

## Cost and receipts

- **`turn-cost`** adds one pill before the shipped token count:
  `≈ $0.123 est.`. It prices uncached input, cache read, cache write, and output
  per model, with peak/off-peak handling, and shows the split in a breakdown
  panel. Unknown model ids fall back by family and are labelled as estimates.
- **`session-diff`** is the durable counterpart: a receipt derived from session
  events, never written by a model. It records file hashes, command exit codes,
  failing lines, models and per-turn cost, and open threads — and keeps
  content-addressed pre-write snapshots for a single-file restore.

Both screens share a price table today (kept in sync by hand). Extracting one
shared rates module is the obvious first cross-package refactor; see
[`docs/porting.md`](docs/porting.md).

## Orchestration and agents

- **`fleet-preset`** turns a session into Fleet: sharpen the request into a
  delegation brief, size the swarm, delegate work with disjoint scopes, verify,
  and synthesize once. Model routing reserves the strong model for design and
  adjudication. The playbook lives in
  [`skills/fleet-orchestration/SKILL.md`](plugins/fleet-preset/skills/fleet-orchestration/SKILL.md).
- **`fleet-view`** visualizes what the swarm is doing and what it costs.
- **`packs/hivemind`** is the cross-app counterpart: nine agent roles (architect,
  builder, researcher, scout, spec-architect, surgeon, verifier, auditor,
  oracle), an adaptive DAG `/swarm`, `/brainstorm` to spec, a `/stack` provider
  switcher, and five profiles for OpenCode v2, installed with one script.

## Safety and diagnostics

- **`session-tripwire`** is a workspace-scoped write-intent ledger shared by
  every session. It hashes writes, leases paths with TTL and fencing, and warns
  or blocks when another session holds the file. The board shows holders,
  hashes, the ignore list, and a kill switch.
- **`dsh-doctor`** finds defects before a session hits them: install/duplicate
  versions, plugin wiring, config, workspace state. `--nightmares` emits the
  feed the board consumes; `--fix` is a dry run unless `--yes`; `--explain`
  links a check to its last recorded failure.

## Layout

```
plugins/<name>/        installable DSH packages (host + optional client half)
packs/hivemind/        OpenCode agents, commands, skills, profiles, installer
experiments/           unpackaged design work
docs/                  architecture, porting, installation
scripts/               link-profile, verify, test-all
```

## Install

```powershell
gh repo clone DevRishii/plugin-library
cd plugin-library
npm run verify
npm test
npm run link        # wires the desktop profile (npm run link:dry first)
```

`npm run link` adds each package to the profile's `@local/*` dependencies and
`dsh.profile.bundles`, and points the matching `node_modules/@local` junctions
at this repository. It backs up the profile manifest first. Then restart the app
(the `restart-app` button or `/restart-app`).

> The desktop profile on this machine currently links the original workspace
> copies, not this repository. Running `npm run link` switches it to the
> library; the old copies can be archived afterwards.

See [`docs/installation.md`](docs/installation.md) for the manual wiring, the
full change list, and the development loop.

## Reuse beyond DeepSeek Harness

The library is deliberately split into pure cores and thin host bindings:

| Package | Portability | Portable core |
| --- | ---: | --- |
| `dsh-doctor` | 4/5 | all checks and fix planning; CLI-first |
| `packs/hivemind` | 4/5 | agent/command Markdown + stack switcher |
| `session-diff` | 3/5 | receipt facts, snapshots, renderers, CLI |
| `session-tripwire` | 3/5 | ledger, leases, conflict decisions |
| `turn-cost` | 2/5 | rate table and bucket pricer |
| `fleet-view` | 2/5 | tree walk and totals |
| `theme-engine` | 2/5 | palette catalog by semantic role |
| `restart-app` | 2/5 | relaunch state machine |
| `idea-board` | 2/5 | dream/nightmare stores, brief generator |
| `fleet-preset` | 2/5 | persona, playbook, budget and route tables |

[`docs/porting.md`](docs/porting.md) defines the host ports (sessions, usage,
storage, tools, UI slots, agents, scheduler, fs intent, shell) and the recipe
for adding a second host binding. [`docs/architecture.md`](docs/architecture.md)
covers how DSH loads a bundle, where state lives, and the intentional
cross-plugin links.

## Development

```powershell
npm test          # every plugin's suite (181 tests today)
npm run verify    # package shape, secrets, personal paths, stray state
npm run check     # both
npm run doctor    # dsh-doctor against the current workspace
npm run receipt   # session receipt for the latest session
```

Add a plugin under `plugins/<name>/`, give it a unique `@local/<name>`, declare
`dsh.bundle.patch` and/or `dsh.client`, add tests, rerun `npm run link`, and add
a catalog row.

## Privacy

The repository is private and intentionally contains no:

- API keys, tokens, or credentials (verify scans for common key shapes);
- session logs, receipts, board JSON, or tripwire journals (`.gitignore` and
  `verify` exclude `.dsh/` state);
- absolute user paths (verify rejects `C:\Users\<name>\`; the Fleet skill root
  is resolved from the profile instead of hardcoded).

Session-derived data stays under `~/.dsh` and `<workspace>/.dsh` on the machine
that produced it.
