# Hivemind Stack Switcher for OpenCode v2

A `/stack` picker for [OpenCode](https://opencode.ai) v2. Swap provider stacks
(GPT / Claude / Gemini / DeepSeek / OpenCode Go) straight from the composer —
no terminal, no restart.

```
/stack                      → show the active stack and topology
/stack/chatgpt-deepseek     → pick a stack (each shows its use case)
/stack/claude-hybrid
/stack/claude-native
/stack/argon-deepseek
/stack/opencode-go-max
/swarm <task>               → adaptive DAG swarm
/brainstorm <dump>          → compile the dump to .opencode/SPEC.md
```

Typing `/stack` in the composer lists every stack with its description, so you
choose from a menu instead of typing a profile name.

Hivemind v2.5 adds an adaptive DAG `/swarm` and a `/brainstorm` front door that
compiles a thought dump into `.opencode/SPEC.md` before any code is written.

## Requirements

- OpenCode **v2** (`opencode` CLI 2.2.x or newer, and/or OpenCode Desktop v2).
  v1 is not supported.
- Windows, macOS, Linux or WSL.
- Python 3 on macOS / Linux / WSL (the POSIX switcher uses it).

## Install

### Windows (PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Then activate a stack once:

```powershell
hive-switch chatgpt-deepseek
```

### macOS / Linux / WSL

```bash
bash install.sh
~/.local/bin/hive-switch chatgpt-deepseek
```

Restart OpenCode Desktop **once** after installing (so it picks up the new
commands). After that, switching never needs a restart.

## The stacks

| Command | Topology (cap) | Orchestrator | Workers | Use it when |
|---|---|---|---|---|
| `/stack/chatgpt-deepseek` | High-Concurrency DeepSeek Fan-Out (6) | GPT-6.1 Sol | DeepSeek Flash | Default. Day-to-day features at near-zero marginal cost. |
| `/stack/claude-hybrid` | Autonomous Feature Pods (4) | Claude Opus 5.5 | Sonnet 5.5 + DeepSeek Flash | Hard refactors needing strong architecture and surgical edits. |
| `/stack/claude-native` | Autonomous Feature Pods (4) | Claude Opus 5.5 | Sonnet 5.5 + Haiku 5.5 | Pure Anthropic; no DeepSeek key needed. |
| `/stack/argon-deepseek` | Macro-Context Lead + Parallel Builders (5) | Gemini 4 Argon | DeepSeek Flash | Long runs without burning ChatGPT/Claude quota. |
| `/stack/opencode-go-max` | Full Ensemble Council (6) | GPT-6.1 Sol | GLM-5.3-Flash + DeepSeek Flash | High-volume parallel packet work. |

Each stack also repoints the nine Hivemind agents (`hivemind-architect`,
`builder`, `researcher`, `scout`, `spec-architect`, `surgeon`, `verifier`,
`auditor`, `oracle`) and applies its agent step budgets.

## Commands

- `/swarm <task>` — adaptive DAG. Tier 1 runs direct for <= 2 files; otherwise
  recon -> contract lock -> parallel builders -> verify/audit gate.
- `/brainstorm <dump>` — `@spec-architect` writes `.opencode/SPEC.md` (contracts,
  ownership matrix, verification), then offers `/swarm`.
- `/audit-diff` — read-only review of the working diff.
- `/stack` — show the active stack and topology; `/stack/<name>` switches.

## Context vault (Obsidian-compatible)

After a goal passes the verification gate, Hivemind may checkpoint it into an
optional vault at `.opencode/vault/` with a zero-dependency `scripts/vault.mjs`
CLI. `/swarm` asks once, with exact `Yes` / `No` options, whether to create a
vault (`absent` / `partial`) or refresh one (`present_healthy` /
`present_unhealthy`). `No` writes nothing; CI auto-selects `No`. `/brainstorm`
and `@spec-architect` run a vault-first gate, emit `vault-gate: <state>` before
any file exploration, and use L0–L2 notes instead of blind scans. Every stack
enforces `tier(spec-architect) >= tier(builder) + 1`; `hive-switch` fails closed
on violations.

The lifecycle CLI is locked in contract but not yet implemented end to end in
this checkout. See [`docs/context-vault/GUIDE.md`](../../docs/context-vault/GUIDE.md)
and [`docs/context-vault/USAGE.md`](../../docs/context-vault/USAGE.md).

When upgrading, existing prompts are kept by default. Pass `-Force` (PowerShell)
or `FORCE=1` (POSIX) to refresh bundled agent/command prompts; back up local
customizations first. The installer places Hive CLIs and the vault kit under
`~/.config/hivemind/`; a project's scaffolded `scripts/vault.mjs` remains the
project-local query surface.

## How it works

`hive-switch` deep-merges `base-opencode.json` (provider options and model
variants) under the chosen profile's `opencode_config`, writes
`~/.config/opencode/opencode.json`, and rewrites the `model:` and `steps:` lines
of every mapped agent in `~/.config/opencode/agents/`.

It also regenerates the `ACTIVE STACK TOPOLOGY` block in `AGENTS.md` — topology
name, `MAX_PARALLEL_SUBAGENTS`, verification gate, step budgets, and the stack
directive — and mirrors agents/commands to `~/.config/hivemind/opencode/`.

OpenCode watches its config directory and **reloads automatically**, so the
running Desktop app picks up a switch within a second or two — no restart, no
IPC. The `/stack/*` commands trigger that switch through a command *shell block*,
which runs before any model call.

On Windows the block invokes `powershell -File <path>` explicitly instead of
calling `hive-switch.cmd` directly. A quoted path used as a command name is a
parse error in PowerShell (`Unexpected token 'chatgpt-deepseek'`), whereas the
explicit `powershell -File` form parses in both PowerShell and cmd.exe.

## Credentials

No secrets are included. Profiles reference `{env:DEEPSEEK_API_KEY}`, which
OpenCode resolves from the environment at runtime.

- **ChatGPT / Claude OAuth:** connect under **Settings → Providers** in Desktop,
  or run `opencode auth login` once.
- **DeepSeek:** set `DEEPSEEK_API_KEY` in your user environment so GUI launches
  (Start Menu / Dock) inherit it, not just terminals.

## What gets installed

```
~/.config/hivemind/profiles/*.json          5 stack definitions
~/.config/hivemind/base-opencode.json       shared provider / model config
~/.config/hivemind/hive-switch[.ps1]        switcher implementation
~/.config/hivemind/opencode/                mirror of agents, commands, AGENTS.md
~/.config/opencode/AGENTS.md                global rules + generated topology block
~/.config/opencode/agents/*.md              9 Hivemind agents
~/.config/opencode/commands/                /swarm, /brainstorm, /audit-diff, /stack
~/.config/opencode/commands/stack/*.md      one command per stack
~/.config/opencode/skills/                  token-discipline skill
~/.local/bin/hive-switch[.cmd|.ps1]         PATH entry point / forwarder
```

## Safety

The installer is non-destructive:

- existing `opencode.json` and profiles are backed up as `*.bak.<timestamp>`
- existing agent prompts, `AGENTS.md`, `/swarm`, `/brainstorm` and `/audit-diff`
  are **kept** (pass `-Force` / `FORCE=1` to overwrite them with the bundled
  versions)
- `opencode.json` is only rewritten when you explicitly activate a stack
- `AGENTS.md` changes on a switch only inside the `HIVEMIND:TOPOLOGY` markers
  (the generated block); edit the constitution above them by hand

## Troubleshooting

**`/stack` doesn't appear** — restart OpenCode Desktop once after installing;
commands are read at startup.

**The switch runs but the reply errors** — the config already changed; the
error is the follow-up prompt having no authenticated model. Finish OAuth (or
set `DEEPSEEK_API_KEY`) and it disappears.

**Bare `hive-switch` not found** — add `~/.local/bin` (`%USERPROFILE%\.local\bin`
on Windows) to PATH. The `/stack` commands use an absolute path, so they work
even without it.

## Uninstall

```bash
rm -rf ~/.config/opencode/commands/stack
rm -f  ~/.config/opencode/commands/stack.md
rm -rf ~/.config/hivemind/opencode
rm -f  ~/.config/hivemind/base-opencode.json ~/.config/hivemind/hive-switch.ps1
rm -f  ~/.local/bin/hive-switch ~/.local/bin/hive-switch.ps1 ~/.local/bin/hive-switch.cmd
```
