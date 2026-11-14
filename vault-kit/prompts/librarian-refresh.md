## Context Librarian Refresh Protocol (`context-librarian` + `vault-lifecycle.mjs update`)

Use this protocol when the post-goal checkpoint answers `Yes` to `Refresh Context Vault`, when
`detect` reports `present_unhealthy`, or when a user runs `/vault-refresh`. The librarian is
read-only with respect to application source and `_schema`: it refreshes vault notes only.

### 1. Scope the refresh to drift (never a full-repo rewrite)
1. Run `node scripts/hive/vault-lifecycle.mjs update --goal <goal_id> --since <git-ref> --json`.
   Installed consumer projects without local `scripts/hive/` use
   `~/.config/hivemind/scripts/hive/vault-lifecycle.mjs update ...` with the same flags.
2. Keep ONLY notes that are provably drifted:
   - a note frontmatter `source_hash` differs from the hash of its current source range;
   - a `path#symbol` pointer no longer resolves (the file, the symbol, or both are gone);
   - a note whose pointer path changed since the `--since` ref
     (`git diff --name-only <git-ref>...HEAD`).
3. Drop every other note from the work set. Touching a note outside the drift set is a protocol
   violation: report it instead of rewriting it.

### 2. Re-read drifted ranges with `slice` (never whole files)
- For each drifted `path#symbol` pointer run
  `node scripts/vault.mjs slice --file <path> --symbol <name>`.
- `slice` is capped at 120 lines. Never widen the range and never `read` the whole file.
- Exit `3` (not found) or `4` (stale index): run `node scripts/vault.mjs index` once, then retry the
  same `slice` once. If it still fails, mark that note `stale` and report the typed error; do not
  guess at the symbol.
- Exit `2` (validation or budget): narrow the symbol or split the note; report the failure if that
  is impossible.

### 3. Rewrite notes (bounded, pointer-first)
- Keep every note under 400 estimated tokens; the L0 `00-MOC.md` note is also capped at 400.
- Copy no source code bodies, no multi-line signatures, and no diffs. Record behavior in one line
  and link notes instead: `[[contract-<name>]]`, `[[slice-<id>]]`, `[[map-repo]]`.
- Keep pointers as `path#symbol` (repository-relative path plus the symbol name).
- Recompute the note `source_hash` from the exact range that was sliced.
- Re-derive `20-contracts/contract-*.md` and `30-slices/slice-*.md` only for changed paths. Delete a
  derived note only when both its path and its symbol are gone.
- Never edit `_schema/**`, `.opencode/vault/README.md`, or application source code.

### 4. Verify (both commands must exit `0`)
1. `node scripts/vault.mjs index`
2. `node scripts/vault.mjs check --strict`
- `check --strict` exit `4` means the index is stale: run `index` once and retry `check --strict`
  once.
- Any other non-zero exit: stop, report the exit code plus the offending note path, and never claim
  the refresh succeeded. The refresh is complete only when both commands exit `0`.

### 5. Report (bounded)
At most 5 bullets: notes refreshed, notes marked stale, derived notes removed, `index_exit`,
`check_exit`. No diffs, no logs, no source excerpts.