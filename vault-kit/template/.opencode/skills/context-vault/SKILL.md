---
name: context-vault
description: Progressive disclosure for the context vault - read the MOC first, then brief, find, and slice instead of scanning the repository. Load before exploring an unfamiliar repository or writing a handoff digest.
license: MIT
---

# Context Vault

## Read order (mandatory)
- L0: `{{VAULT_DIR}}/00-MOC.md` (`[[moc-root]]`) - the only note you read in full.
- L1: `node scripts/vault.mjs brief --task <id> --budget 1200` - bounded task digest.
- L2: `node scripts/vault.mjs find --query <q> --limit 8` and `node scripts/vault.mjs slice --file <path> --symbol <name>`.
- L3: one handoff digest per slice, at most 5 bullets and 400 estimated tokens.

## Rules
- Never start with a recursive directory listing or a whole-file read.
- Keep pointers as `path#symbol`; no code bodies, diffs, logs, or embeds in notes.
- `check --strict` must exit `0` before you claim the vault is healthy.
- Exit codes: `0` ok, `1` internal, `2` validation or budget, `3` not found or refused, `4` stale index.