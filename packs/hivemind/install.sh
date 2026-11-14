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
#   FORCE=1 bash install.sh                 # overwrite existing prompt files

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HM_HOME="$HOME/.config/hivemind"
OC_DIR="$HOME/.config/opencode"
BIN_DIR="$HOME/.local/bin"
STAMP="$(date +%Y%m%d_%H%M%S)"
FORCE="${FORCE:-0}"
ACTIVATE=""

while getopts "a:h" opt; do
  case "$opt" in
    a) ACTIVATE="$OPTARG" ;;
    h) sed -n '2,32p' "$0"; exit 0 ;;
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
