---
id: map-repo
title: Repository map
type: map
status: active
owner: architect
scope: tooling
updated: {{DATE}}
summary: Where {{PROJECT_NAME}} keeps source, tests, and the commands that keep it honest.
---

# Repository map

{{PROJECT_NAME}} - {{PROJECT_ONE_LINER}}

- Stack: {{STACK}}
- Source roots: {{SRC_DIRS}}
- Validation command: `{{TEST_CMD}}`

## Read order
1. [[moc-root]] for the entry point.
2. This note for layout.
3. [[map-layers]] for boundaries.
4. `node scripts/vault.mjs brief --task <slice-id>` for a bounded digest.

## Rules
- Query the vault before opening files: `find`, then `slice`.
- Keep pointers as `path#symbol`; never paste file bodies into notes.
- Re-run `node scripts/vault.mjs index` after a source change, then `check --strict`.