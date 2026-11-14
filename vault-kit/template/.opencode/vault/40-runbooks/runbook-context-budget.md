---
id: runbook-context-budget
title: Context budget runbook
type: runbook
status: active
owner: architect
scope: process
updated: {{DATE}}
summary: Token budgets and the L0 to L2 retrieval order that keeps runs cheap.
---

# Context budget runbook

- L0: read `{{VAULT_DIR}}/00-MOC.md` (max 400 estimated tokens) before any exploration.
- L1: `node scripts/vault.mjs brief --task <id> --budget 1200`.
- L2: `node scripts/vault.mjs find --query <q> --limit 8` then `slice --file <path> --symbol <name>` (max 120 lines).
- L3: one handoff digest, max 400 estimated tokens and 5 bullets.
- Estimate tokens as UTF-8 bytes divided by 4; never paste file bodies into notes.

Entry point: [[moc-root]]. Digest rules: [[runbook-handoff]].