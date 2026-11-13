# Hivemind Stack Switcher for OpenCode v2

A `/stack` picker for [OpenCode](https://opencode.ai) v2. Swap provider stacks
(GPT / Claude / Gemini / DeepSeek / OpenCode Go) straight from the composer —
no terminal, no restart.

```
/stack                      → show the active stack
/stack/chatgpt-deepseek     → pick a stack (each shows its use case)
/stack/claude-hybrid
/stack/claude-native
/stack/argon-deepseek
/stack/opencode-go-max
```

Typing `/stack` in the composer lists every stack with its description, so you
choose from a menu instead of typing a profile name.

## Requirements

- OpenCode **v2** (`opencode` CLI 2.2.x or newer, and/or OpenCode Desktop v2).
  v1 is not supported.
- Windows, macOS, Linux or WSL.

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

| Command | Orchestrator | Workers | Use it when |
|---|---|---|---|
| `/stack/chatgpt-deepseek` | GPT-6.1 Sol | DeepSeek Flash | Default. Day-to-day features at near-zero marginal cost. |
| `/stack/claude-hybrid` | Claude Opus 5.5 | Sonnet 5.5 + DeepSeek Flash | Hard refactors needing strong architecture and surgical edits. |
| `/stack/claude-native` | Claude Opus 5.5 | Sonnet 5.5 + Haiku 5.5 | Pure Anthropic; no DeepSeek key needed. |
| `/stack/argon-deepseek` | Gemini 4 Argon | DeepSeek Flash | Long runs without burning ChatGPT/Claude quota. |
| `/stack/opencode-go-max` | GPT-6.1 Sol | GLM-5.3-Flash + DeepSeek Flash | High-volume parallel packet work. |

Each stack also repoints the six Hivemind agents (`hivemind-architect`, `scout`,
`surgeon`, `verifier`, `auditor`, `oracle`).

## How it works

`hive-switch` writes `~/.config/opencode/opencode.json` from the chosen profile
in `~/.config/hivemind/profiles/`, and rewrites the `model:` line of each agent
in `~/.config/opencode/agents/`.

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
~/.config/opencode/AGENTS.md                global rules
~/.config/opencode/agents/*.md              6 Hivemind agents
~/.config/opencode/commands/                /swarm, /audit-diff, /stack
~/.config/opencode/commands/stack/*.md      one command per stack
~/.config/opencode/skills/                  token-discipline skill
~/.local/bin/hive-switch[.cmd|.ps1]         the switcher
```

## Safety

The installer is non-destructive:

- existing `opencode.json` and profiles are backed up as `*.bak.<timestamp>`
- existing agent prompts, `AGENTS.md`, `/swarm` and `/audit-diff` are **kept**
  (pass `-Force` / `FORCE=1` to overwrite them with the bundled versions)
- `opencode.json` is only rewritten when you explicitly activate a stack

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
rm -f  ~/.local/bin/hive-switch ~/.local/bin/hive-switch.ps1 ~/.local/bin/hive-switch.cmd
```
