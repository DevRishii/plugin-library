---
id: runbook-handoff
title: Handoff runbook
type: runbook
status: active
owner: architect
scope: process
updated: {{DATE}}
summary: One bounded digest per slice - outcome, files, acceptance command, blockers.
---

# Handoff runbook

- Write with `node scripts/vault.mjs handoff write --run <run-id> --slice <slice-id> --status <status> --owner <role> --body "- <bullet>"`.
- Destination: `{{VAULT_DIR}}/90-handoffs/<run-id>/<slice-id>.handoff.md`; override with `--runs-dir`.
- At most 5 bullets and 400 estimated tokens; no diffs, logs, or fenced code.
- A `done` digest is immutable: a second write exits `3`. `failed` and `blocked` may be replaced.
- Read digests with `handoff list --run <run-id>`; never paste raw transcripts.

Entry point: [[moc-root]].