<!-- context-vault:begin -->
## Context vault (progressive disclosure)

- L0 entry: begin every run at `{{VAULT_DIR}}/00-MOC.md` (`[[moc-root]]`). Never start with a recursive listing or a whole-file read.
- L1 brief: `node scripts/vault.mjs brief --task <id> --budget 1200` and paste the brief verbatim into a builder prompt.
- L2 slice: `node scripts/vault.mjs find --query <q> --limit 8` then `node scripts/vault.mjs slice --file <path> --symbol <name>` (at most 120 lines).
- L3 handoff: one digest per slice, at most 5 bullets and 400 estimated tokens, via `node scripts/vault.mjs handoff write`.
- Verify with `node scripts/vault.mjs index` and `node scripts/vault.mjs check --strict`; project checks run `{{TEST_CMD}}`. Exit codes are `0` ok, `1` internal, `2` validation or budget, `3` not found or refused, `4` stale index.
<!-- context-vault:end -->