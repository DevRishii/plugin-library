# Context vault

This directory is a pointer map, not a copy of the code.

## Layout
- `00-MOC.md` - L0 entry note (`moc-root`); read it before exploring the repository.
- `10-map/` - repository and layer maps.
- `20-contracts/` - one note per shared interface (`contract-*.md`).
- `30-slices/` - one note per owned slice of work (`slice-*.md`).
- `40-runbooks/` - process notes for runs, handoffs, and budgets.
- `90-handoffs/` - runtime handoff digests, one directory per run id.
- `_schema/` - frontmatter, index, handoff, and canonical note-id schemas.
- `.index/` - generated context index; never edit it by hand.

## Commands
- `node scripts/vault.mjs index` - rebuild `.index/context-index.json`.
- `node scripts/vault.mjs check --strict` - validate notes, links, budgets, and ids.
- `node scripts/vault.mjs brief --task <id> --budget 1200` - bounded task digest.
- `node scripts/vault.mjs find --query <q> --limit 8` - search notes without scanning files.
- `node scripts/vault.mjs slice --file <path> --symbol <name>` - one symbol, at most 120 lines.
- `node scripts/vault.mjs handoff write|list ...` - write or read run digests.
- `node scripts/vault.mjs stats` - index freshness and note sizes.

## Exit codes
`0` ok, `1` internal, `2` validation or budget, `3` not found or refused, `4` stale or missing index.

## Rules
- Keep every note under 400 estimated tokens; the MOC is capped at 400.
- No code bodies, diffs, logs, or embeds. Pointers only.
- Exit codes are the contract: never claim a check passed without running it.