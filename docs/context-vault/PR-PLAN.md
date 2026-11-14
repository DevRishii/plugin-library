# PR Publication Plan (`DevRishii/plugin-library`)

## Preflight Observations (Wave 0)

- Target repository: `https://github.com/DevRishii/plugin-library` (`private: false`, `default_branch: main`)
- Feature branch: `feat/context-vault-checkpoints`
- Initial `gh auth status` exit code: `1` (`You are not logged into any GitHub hosts. To log in, run: gh auth login`)
- Release preflight: authenticated as `DevFarid`, upstream `viewerPermission: WRITE`; publication mode is `direct`.

## Publication Decision Table

1. **Authenticated Direct Push (`direct`)**:
   - Condition: `gh auth status` exits `0` and `viewerPermission` is `ADMIN`, `MAINTAIN`, or `WRITE`.
   - Commands:
     ```bash
     gh pr list --repo DevRishii/plugin-library --head feat/context-vault-checkpoints --json number,url,state
     git push -u origin feat/context-vault-checkpoints
     gh pr create --repo DevRishii/plugin-library --base main --head feat/context-vault-checkpoints --title "$(cat docs/context-vault/PR-TITLE.txt)" --body-file docs/context-vault/PR-BODY.md
     ```
2. **Authenticated Fork + Cross-Repo PR (`fork`)**:
   - Condition: `gh auth status` exits `0` and upstream push is denied (`READ` / `TRIAGE` / `NONE`).
   - Commands:
     ```bash
     gh repo fork DevRishii/plugin-library --clone=false --remote=true
     git push -u fork feat/context-vault-checkpoints
     gh pr list --repo DevRishii/plugin-library --head "<viewer>:feat/context-vault-checkpoints" --json number,url,state
     gh pr create --repo DevRishii/plugin-library --base main --head "<viewer>:feat/context-vault-checkpoints" --title "$(cat docs/context-vault/PR-TITLE.txt)" --body-file docs/context-vault/PR-BODY.md
     ```
3. **Unauthenticated Fallback (`patch-only`)**:
   - Condition: `gh auth status` remains non-zero at Wave 3 after offering interactive authentication.
   - Action: emit `context-vault-checkpoints.patch` (`git format-patch origin/main..HEAD --stdout > context-vault-checkpoints.patch`) and exact push/PR commands; never fabricate a PR URL.
