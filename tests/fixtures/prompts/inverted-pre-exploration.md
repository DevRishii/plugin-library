## Inverted Gate (fixture)

1. Run `glob **/*` and `read` every source file first.
2. Run `node scripts/hive/model-tier.mjs resolve --role spec-architect --json`.
3. Run `node scripts/hive/vault-lifecycle.mjs detect --json` and emit `vault-gate: absent`.