---
id: moc-root
title: {{PROJECT_NAME}} context vault
type: moc
status: active
owner: architect
scope: tooling
updated: {{DATE}}
summary: Entry point for progressive-disclosure context retrieval in {{PROJECT_NAME}}.
---

# {{PROJECT_NAME}} context vault

{{PROJECT_ONE_LINER}}

Read this note first, then open only the note the task needs. Do not scan the repository before querying the vault.

## Maps
- [[map-repo]] - repository layout, stack ({{STACK}}), and validation command.
- [[map-layers]] - layer boundaries and allowed dependency direction.

## Runbooks
- [[runbook-swarm-run]] - lock contracts, dispatch slices, verify once.
- [[runbook-handoff]] - one bounded digest per slice.
- [[runbook-context-budget]] - token budgets and the L0 to L2 read order.

## Contracts
Shared interfaces live in `20-contracts/contract-*.md`. Link each new contract here so it stays reachable within two hops.

## Slices
Owned work lives in `30-slices/slice-*.md`. Link each slice here and keep the list current.

## Handoffs
Run digests are written to `{{VAULT_DIR}}/90-handoffs/<run-id>/` and read with `node scripts/vault.mjs handoff list`.