# Context vault checkpoint release

Feature branch: `feat/context-vault-checkpoints`; target: `DevRishii/plugin-library:main`.

Acceptance commands:
- `node --test tests/hive/*.test.mjs`
- `node scripts/hive/model-tier.mjs verify --strict --json`
- `node scripts/verify.mjs`
- `node scripts/test-all.mjs`

Windows installer tested in a disposable home: installed kit, lifecycle and tier
scripts exist; installed tier verification and fresh-project scaffold/check pass.
POSIX installer/switcher runtime checks require a POSIX host and were not run here.

Review regressions covered: index destination symlink escape, custom vault directory
propagation, application script collision, missing consent, bare root flag, and
registry overrides masking raw switch mappings. No new dependencies or lockfile edits.

Unrelated local `.opencode/pr-review/` artifacts are excluded from this feature.
