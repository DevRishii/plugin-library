## Minimal Valid Gate (fixture)

1. Run `node scripts/hive/model-tier.mjs resolve --role spec-architect --json`.
2. Run `node scripts/hive/vault-lifecycle.mjs detect --json`.
3. Emit `vault-gate: present_healthy`.
4. Only then run `grep` for the target symbols.