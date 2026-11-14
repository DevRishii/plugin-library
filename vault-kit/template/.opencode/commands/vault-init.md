---
description: Scaffold the context vault and the zero-dependency vault CLI into this repository, then verify it.
---

1. Copy the vault kit template into the repository root: `AGENTS.vault-snippet.md`, `.opencode/`, and `scripts/vault.mjs` with `scripts/vault/`.
2. Substitute the closed placeholder set with project values: project name, one-liner, stack, source roots, test command, vault directory, and today's date. Do not invent extra tokens.
3. Splice `AGENTS.vault-snippet.md` into `AGENTS.md` between `<!-- context-vault:begin -->` and `<!-- context-vault:end -->`; keep the markers idempotent.
4. Run `node scripts/vault.mjs index`, then `node scripts/vault.mjs check --strict`. Both must exit `0`.
5. Report the vault directory, note count, both exit codes, and any missing canonical note.