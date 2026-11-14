---
id: map-layers
title: Layer map
type: map
status: active
owner: architect
scope: tooling
updated: {{DATE}}
summary: Layer boundaries and the dependency direction each layer is allowed to use.
---

# Layer map

- Entry surfaces (CLI, HTTP, UI) call core services; they never own business rules.
- Core services own behavior and must not import entry surfaces.
- Shared contracts live in `20-contracts/` and are read-only for builders.
- Deterministic paths only: same input, same output, no hidden network calls.

## Where behavior lives
- Stack: {{STACK}}
- Source roots: {{SRC_DIRS}}
- Validation: `{{TEST_CMD}}`

Back to [[moc-root]].