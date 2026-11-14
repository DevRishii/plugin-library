## Bounded L3 Handoff Digests (`handoff-rules`)

Every builder, verifier and auditor closes its slice by writing ONE L3 digest. The orchestrator
reads digests only (`handoff list`), never raw slice transcripts, diffs or logs.

### 1. Write one digest per slice
```bash
node scripts/vault.mjs handoff write --run <run-id> --slice <slice-id> --status <done|failed|blocked> --owner <role>
```
- Destination: `<VAULT_DIR>/90-handoffs/<run-id>/<slice-id>.handoff.md`, i.e.
  `.opencode/vault/90-handoffs/<run-id>/<slice-id>.handoff.md` by default. Projects that override the
  layout pass `--runs-dir <dir>` (for example `--runs-dir 40-runs`) and get
  `<dir>/<run-id>/<slice-id>.handoff.md`.
- Body: the digest bullets. Supply them through the CLI's documented body input (stdin or body flag;
  check `node scripts/vault.mjs handoff write --help`). Never embed a diff, patch or raw log.
- `<run-id>` and `<slice-id>` use only `[A-Za-z0-9._-]`, at most 64 characters. Anything else is
  refused with exit `2`.
- One digest per slice per run. Do not write a second digest for the same slice id; re-run the slice
  instead.

### 2. Caps (hard)
- at most 5 bullets;
- at most 400 estimated tokens per digest;
- zero fenced code blocks, zero diffs, zero raw logs, zero file bodies.

A digest over a cap is rejected with exit `2`. Trim it; never retry the same oversized body.
Content: outcome, changed files, ACCEPTANCE_CHECK command plus observed result, blockers, and at
most one integration caveat.

### 3. Status semantics
- `done`: the slice passed its ACCEPTANCE_CHECK. A `done` digest is immutable - writing the same
  `<run-id>/<slice-id>` again exits `3` (refused overwrite). Never overwrite, never append.
- `failed` / `blocked`: replaceable by a later attempt of the same slice in the same run.
- Always record the ACCEPTANCE_CHECK command with its observed result. "tests pass" without the
  command is not a valid digest, and a missing result is `blocked`, not `done`.

### 4. Orchestrator read path
`node scripts/vault.mjs handoff list --run <run-id>` returns the digests for a run. Integrate from
that output only; open an individual note by path only when a digest is ambiguous.