---
id: runbook-swarm-run
title: Swarm run runbook
type: runbook
status: active
owner: architect
scope: process
updated: {{DATE}}
summary: Bounded multi-agent run - lock contracts, dispatch disjoint slices, verify once.
---

# Swarm run runbook

1. Lock shared contracts before dispatch; only the architect edits them.
2. Give each builder owned files, read-only contracts, and one acceptance command.
3. Dispatch independent slices in parallel; keep dependent slices for the next wave.
4. Each builder closes its slice with one digest per [[runbook-handoff]].
5. Verify the integrated result once with `{{TEST_CMD}}`, then `index` and `check --strict`.

Budgets: [[runbook-context-budget]]. Entry point: [[moc-root]].