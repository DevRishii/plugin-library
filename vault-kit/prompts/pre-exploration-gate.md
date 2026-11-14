## Pre-Exploration Obsidian Context Vault & Model-Tier Gate (Mandatory First Step)

Run this gate **before** any repository file exploration, directory listing, `glob`, `grep`, or source `read`:

1. **Resolve and verify the `spec-architect` model tier first** (never downgrade below worker/`builder` tier):
   ```bash
   node scripts/hive/model-tier.mjs resolve --role spec-architect --profile <active-profile> --json
   ```
   (When running in an installed consumer project outside `plugin-library`, fall back to `~/.config/hivemind/scripts/hive/model-tier.mjs`.) Every Hivemind stack enforces `tier(spec-architect) >= tier(builder) + 1`; refuse any override that violates this invariant.
2. **Detect existing Obsidian Context Vault** (read-only sentinel + health check on `.opencode/vault/00-MOC.md` and `scripts/vault.mjs`):
   ```bash
   node scripts/hive/vault-lifecycle.mjs detect --json
   ```
   (Fallback in installed consumer projects: `~/.config/hivemind/scripts/hive/vault-lifecycle.mjs detect --json`, or stat `.opencode/vault/00-MOC.md` and `scripts/vault.mjs` directly.)
3. **Emit the gate marker** into the run context before any source read:
   `vault-gate: <state>` (`absent | partial | present_healthy | present_unhealthy`).
4. **Branch by state**:
   - **Vault present (`present_healthy` or `present_unhealthy`)** — follow L0 -> L2 progressive disclosure within a <= 1,600 estimated-token pre-exploration budget:
     a. Run `node scripts/vault.mjs index` then `node scripts/vault.mjs check --strict` (on exit `4`, run `index` once and retry; on any other non-zero code, report the typed error and continue with the vault as degraded read-only context).
     b. Read L0 `.opencode/vault/00-MOC.md` (`[[moc-root]]`) or `node scripts/vault.mjs brief --task moc-root --budget 400`.
     c. Query candidate slices and symbols via `node scripts/vault.mjs brief --task <id> --budget 1200`, `node scripts/vault.mjs find --query <q> --limit 8`, and `node scripts/vault.mjs slice --file <path> --symbol <name>`.
     d. Only for paths unindexed by the vault may you fall back to targeted subdirectory reads, stating which vault query returned zero rows. Broad recursive scans are forbidden unless `find` returned zero rows and the reason is recorded.
   - **Vault absent or partial (`absent` or `partial`)** — proceed with standard Hivemind exploration. Never create a vault mid-brainstorm; vault creation or repair happens exclusively after goal completion.
