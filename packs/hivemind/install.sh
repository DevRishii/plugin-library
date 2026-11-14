#!/usr/bin/env bash
# install.sh — Hivemind Stack Switcher for OpenCode v2 (macOS / Linux / WSL)
#
# What you get in the composer after installing:
#   /stack                     -> show the active stack + topology
#   /stack/chatgpt-deepseek    -> pick a stack from the list (descriptions shown)
#   /stack/claude-hybrid
#   /stack/claude-native
#   /stack/argon-deepseek
#   /stack/opencode-go-max
#   /swarm <task>              -> adaptive DAG swarm
#   /brainstorm <dump>         -> compile the dump to .opencode/SPEC.md
#   /pr-review <pr-link>       -> multi-angle PR review swarm (parallel lenses + intent gate)
#
# Installs:
#   ~/.config/hivemind/profiles/*.json
#   ~/.config/hivemind/base-opencode.json
#   ~/.config/hivemind/hive-switch
#   ~/.config/opencode/{AGENTS.md,agents/,commands/,skills/}
#   ~/.config/opencode/skills/token-discipline/ and skills/pr-review/ (incl. lenses/)
#   ~/.config/opencode/skills/pr-review/engine/ (bin/, src/, package.json, README.md)
#   ~/.config/opencode/commands/stack.md + commands/stack/*.md
#   ~/.local/bin/hive-switch
#
# Safe by default:
#   - existing profiles and opencode.json are backed up (.bak.<timestamp>)
#   - existing agent prompts, AGENTS.md, /swarm, /brainstorm, /pr-review and /audit-diff are left alone
#   - opencode.json is NOT rewritten unless you pass -a <profile>
#
# Usage:
#   bash install.sh
#   bash install.sh -a chatgpt-deepseek     # also activate a stack
#   bash install.sh -r                      # refresh ONLY PR-review assets (command, agent, skill, lenses, engine)
#   FORCE=1 bash install.sh                 # overwrite existing prompt files

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HM_HOME="$HOME/.config/hivemind"
OC_DIR="$HOME/.config/opencode"
BIN_DIR="$HOME/.local/bin"
STAMP="$(date +%Y%m%d_%H%M%S)"
FORCE="${FORCE:-0}"
ACTIVATE=""
PR_REVIEW_ONLY=0

while getopts "a:hr" opt; do
  case "$opt" in
    a) ACTIVATE="$OPTARG" ;;
    r) PR_REVIEW_ONLY=1 ;;
    h) sed -n '2,35p' "$0"; exit 0 ;;
    *) echo "unknown option" >&2; exit 2 ;;
  esac
done

ok()   { printf '  [ok]   %s\n' "$*"; }
keep() { printf '  [keep] %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*"; }

backup_if_exists() { [ -e "$1" ] && cp -p "$1" "$1.bak.$STAMP" || true; }

install_file() { # src dest keep_existing
  local src="$1" dest="$2" keep_existing="${3:-0}"
  if [ "$keep_existing" = "1" ] && [ -e "$dest" ] && [ "$FORCE" != "1" ]; then
    keep "$(basename "$dest")"; return 0
  fi
  backup_if_exists "$dest"
  cp -f "$src" "$dest"
  ok "$(basename "$dest")"
}

install_dir_files() { # src_dir dest_dir keep_existing
  local src_dir="$1" dest_dir="$2" keep_existing="${3:-0}"
  [ -d "$src_dir" ] || return 0
  mkdir -p "$dest_dir"
  local f
  for f in "$src_dir"/*; do
    [ -f "$f" ] || continue
    install_file "$f" "$dest_dir/$(basename "$f")" "$keep_existing"
  done
}

# Engine lives with the installed skill so the command never depends on a repo
# checkout: ~/.config/opencode/skills/pr-review/engine/{bin,src}.
install_pr_review_engine() { # keep_existing
  local keep="${1:-0}"
  local engine_src="$ROOT/../../plugins/pr-review"
  if [ ! -d "$engine_src" ]; then
    warn "pr-review engine source not found: $engine_src"; return 0
  fi
  local engine_dst="$OC_DIR/skills/pr-review/engine"
  install_dir_files "$engine_src/bin" "$engine_dst/bin" "$keep"
  install_dir_files "$engine_src/src" "$engine_dst/src" "$keep"
  install_file "$engine_src/package.json" "$engine_dst/package.json" "$keep"
  install_file "$engine_src/README.md" "$engine_dst/README.md" "$keep"
  chmod +x "$engine_dst/bin/pr-review.mjs" 2>/dev/null || true
}

install_pr_review_assets() { # keep_existing
  local keep="${1:-1}"
  install_file "$ROOT/opencode/commands/pr-review.md" "$OC_DIR/commands/pr-review.md" "$keep"
  install_file "$ROOT/opencode/agents/pr-reviewer.md" "$OC_DIR/agents/pr-reviewer.md" "$keep"
  install_file "$ROOT/opencode/skills/pr-review/SKILL.md" "$OC_DIR/skills/pr-review/SKILL.md" "$keep"
  if [ -d "$ROOT/opencode/skills/pr-review/lenses" ]; then
    mkdir -p "$OC_DIR/skills/pr-review/lenses"
    local f
    for f in "$ROOT"/opencode/skills/pr-review/lenses/*.md; do
      [ -f "$f" ] || continue
      install_file "$f" "$OC_DIR/skills/pr-review/lenses/$(basename "$f")" "$keep"
    done
  fi
  install_pr_review_engine "$keep"
}

echo
echo "=================================================================="
echo "  HIVEMIND STACK SWITCHER -> OpenCode v2 (macOS / Linux / WSL)"
echo "=================================================================="

if command -v opencode >/dev/null 2>&1; then
  ok "opencode found: $(command -v opencode)"
else
  warn "opencode not on PATH. Install OpenCode v2 (Desktop + CLI 2.2.x+) first."
fi

mkdir -p "$HM_HOME/profiles" "$OC_DIR/agents" "$OC_DIR/commands/stack" \
         "$OC_DIR/skills/token-discipline" "$OC_DIR/skills/pr-review/lenses" "$BIN_DIR"

if [ "$PR_REVIEW_ONLY" = "1" ]; then
  echo
  echo "Focused reinstall -> PR-review assets only"
  install_pr_review_assets 0
  echo
  echo "Done. Profiles, AGENTS.md, opencode.json, other commands/agents, and PATH were not touched."
  echo "Restart OpenCode Desktop once to reload the refreshed PR-review assets."
  exit 0
fi

echo
echo "Profiles -> $HM_HOME/profiles"
for f in "$ROOT"/profiles/*.json; do
  install_file "$f" "$HM_HOME/profiles/$(basename "$f")" 0
done
install_file "$ROOT/base-opencode.json" "$HM_HOME/base-opencode.json" 0

echo
echo "OpenCode config -> $OC_DIR"
install_file "$ROOT/opencode/AGENTS.md" "$OC_DIR/AGENTS.md" 1
for f in "$ROOT"/opencode/agents/*.md; do
  install_file "$f" "$OC_DIR/agents/$(basename "$f")" 1
done
for f in "$ROOT"/opencode/commands/*.md; do
  install_file "$f" "$OC_DIR/commands/$(basename "$f")" 1
done
for f in "$ROOT"/opencode/commands/stack/*.md; do
  install_file "$f" "$OC_DIR/commands/stack/$(basename "$f")" 1
done
for skill in token-discipline pr-review; do
  install_file "$ROOT/opencode/skills/$skill/SKILL.md" "$OC_DIR/skills/$skill/SKILL.md" 1
done
if [ -d "$ROOT/opencode/skills/pr-review/lenses" ]; then
  for f in "$ROOT"/opencode/skills/pr-review/lenses/*.md; do
    install_file "$f" "$OC_DIR/skills/pr-review/lenses/$(basename "$f")" 1
  done
fi
install_pr_review_engine 1

echo
echo "Switcher -> $BIN_DIR"
install_file "$ROOT/bin/hive-switch" "$BIN_DIR/hive-switch" 0
chmod +x "$BIN_DIR/hive-switch"
install_file "$ROOT/bin/hive-switch" "$HM_HOME/hive-switch" 0
chmod +x "$HM_HOME/hive-switch"

# --- point the /stack commands at this machine's switcher ---------------
CMD="$BIN_DIR/hive-switch"
rendered=0
while IFS= read -r -d '' f; do
  if grep -q '{{HIVE_SWITCH_CMD}}' "$f"; then
    # quote the path so it survives spaces in $HOME
    awk -v repl="\"$CMD\"" '{ gsub(/\{\{HIVE_SWITCH_CMD\}\}/, repl); print }' "$f" > "$f.tmp"
    mv "$f.tmp" "$f"
    rendered=$((rendered + 1))
  fi
done < <(find "$OC_DIR/commands" -maxdepth 2 -name '*.md' -print0)
echo
echo "Commands -> $OC_DIR/commands"
ok "$rendered command file(s) wired to $CMD"

case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR already on PATH" ;;
  *) warn "For the bare 'hive-switch' command, add to your shell rc:"
     printf '         export PATH="$HOME/.local/bin:$PATH"\n' ;;
esac

echo
if [ -n "$ACTIVATE" ]; then
  backup_if_exists "$OC_DIR/opencode.json"
  "$BIN_DIR/hive-switch" "$ACTIVATE"
else
  echo "Next steps:"
  echo "  1. Activate a stack:  $BIN_DIR/hive-switch chatgpt-deepseek"
  echo "  2. Restart OpenCode Desktop once, then type /stack in the composer."
fi

echo
echo "=================================================================="
echo "  DONE"
echo "=================================================================="
echo "  /stack                  show the active stack"
echo "  /stack/claude-hybrid    switch stack (pick any from the /stack list)"
echo "  /pr-review <pr-link>    multi-angle PR review swarm"
echo "  OpenCode watches the config directory and reloads automatically."
echo "=================================================================="
