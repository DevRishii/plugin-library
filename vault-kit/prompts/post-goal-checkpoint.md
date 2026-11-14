## Post-Goal Checkpoint (`post-goal-checkpoint`)

Execute this terminal step **only after** the Hivemind goal completes and the verification gate (`@verifier` + `@auditor`) reports clean with zero blockers:

1. **Plan the checkpoint action** (pure, read-only, idempotent per `goal_id`):
   ```bash
   node scripts/hive/vault-lifecycle.mjs plan --goal <goal_id> --json
   ```
   (In installed consumer projects where local `scripts/hive/` is absent, invoke `~/.config/hivemind/scripts/hive/vault-lifecycle.mjs`.)
2. **Inspect `data.action`**:
   - If `data.action == "none"` (already answered for `<goal_id>` or `CI` environment auto-selected `No`): stop without prompting.
   - If `data.action == "prompt_create"` (no Obsidian context vault in project, or `partial` repair) or `data.action == "prompt_update"` (Obsidian context vault already exists in project):
     Call the `question` tool **once** using `{ questions: [plan().data.question] }`, keeping the item **verbatim** (`header`, `question`, and exact `Yes` / `No` options — never paraphrase or add options).
3. **Execute the user's choice**:
   - **`Yes` on `prompt_create`**:
     Run `node scripts/hive/vault-lifecycle.mjs scaffold --yes --json`, then `node scripts/hive/vault-lifecycle.mjs state record --goal <goal_id> --prompt create --choice yes --scaffold-exit <code1> --check-exit <code2> --json`. Report observed `index_exit` and `check_exit` (must both be `0` before claiming success) in at most 5 bullets.
   - **`Yes` on `prompt_update`**:
     Run `node scripts/hive/vault-lifecycle.mjs update --yes --goal <goal_id> --json`, then `node scripts/hive/vault-lifecycle.mjs state record --goal <goal_id> --prompt update --choice yes --check-exit <code> --json`. Report refreshed/stale counts and observed `index_exit` and `check_exit` (`0` required).
   - **`No` (or dismissed)**:
     Write nothing to `.opencode/vault/` or `scripts/vault.mjs`. Record the answer via `node scripts/hive/vault-lifecycle.mjs state record --goal <goal_id> --choice no --json`. Treat `No` as a clean completion, never an error.

Use the resolved installed lifecycle CLI path for every subcommand when local scripts are absent. Keep the consumer project as cwd. A standalone successful `/brainstorm` compilation also reaches this terminal step if the user declines to launch `/swarm`; do not prompt twice for the same goal. Tier 1 uses its targeted self-check as its completion gate.
