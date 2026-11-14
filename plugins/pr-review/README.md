# PR Review

`@local/pr-review` is the zero-dependency engine behind Hivemind's
`/pr-review [pr-link]` command. It turns one pull request into a quarantined
context packet, fans the diff out to specialist reviewer lenses, gates the
result on intent alignment and verified evidence, and publishes a single
idempotent GitHub review.

The engine does not call a model by itself. Hivemind dispatches `@pr-reviewer`
subagents in parallel waves; this package owns the deterministic parts:
ingestion, lens selection, slicing, prompt fencing, report validation,
synthesis, rendering, and publication.

## What is in the box

| Piece | Path | Purpose |
| --- | --- | --- |
| Contracts | `src/contracts.mjs` | Exit codes, error codes, lens registry, PR reference parser, quarantine helpers, schema validators |
| Ingest | `src/ingest.mjs` | Fetch PR metadata and diff, build `PRContextPacket` |
| Slicer | `src/slicer.mjs` | Bounded per-lens diff slices (line, byte, and per-hunk caps) |
| Synthesize | `src/synthesize.mjs` | Evidence checks, corroborative dedupe, `OrchestratedPRReviewPayload` |
| Publish | `src/publish.mjs` | Dry-run render, GitHub review API, duplicate/stale guards |
| CLI | `bin/pr-review.mjs` | `pr-review <command>` entry point |

## Quick start

```powershell
node bin/pr-review.mjs ingest https://github.com/owner/repo/pull/42
node bin/pr-review.mjs lenses --files changed-files.txt
node bin/pr-review.mjs synthesize .pr-review/reports/*.json
node bin/pr-review.mjs publish .pr-review/payload.json
```

Ingest and every later command write JSON to stdout so an orchestrator can pipe
one stage into the next. Human-readable logs go to stderr.

## CLI commands

| Command | What it does |
| --- | --- |
| `ingest <pr-ref>` | Parse and validate the PR reference, fetch metadata and diff, quarantine untrusted text, select lenses and waves, write `PRContextPacket` |
| `lenses` | List the 13 core and 4 conditional lenses; `--files` reports selection reasons and trigger matches |
| `slice` | Emit a bounded diff slice for one lens, capped by `MAX_SLICE_LINES`, `MAX_SLICE_BYTES` (12,000 serialized bytes), and `MAX_HUNK_LINES` (60 lines per hunk); `--max-lines` lowers the line cap |
| `prompt` | Render the fenced `@pr-reviewer` prompt for one lens from `PRContextPacket`: evidence requirements, complete JSON output schema, and a diff slice bounded to `MAX_PROMPT_BYTES` (24,000 UTF-8 bytes) / `MAX_PROMPT_LINES` (500) |
| `validate-report` | Schema-validate a `SubagentReviewReport`, then verify every finding quote and line anchor against the real hunk |
| `synthesize` | Merge reports, deduplicate corroborated findings, enforce the intent gate, and emit `OrchestratedPRReviewPayload` |
| `render` | Render the payload as Markdown (default) or JSON for dry-run inspection |
| `publish` | Publish the review; dry run by default, `--post --confirm` to write to GitHub |
| `selftest` | Run the built-in contract self-check (lens count, parser, quarantine, wave cap) |

Common flags: `--out <path>`, `--json`, `--max-parallel <n>`, `--max-lines <n>`,
`--packet <path>`, `--pr-file <path>`, `--from-fixture <dir>`, `--dry-run`,
`--post`, `--confirm`.

There is no `--budget` flag. Prompt and slice budgets are fixed in
`src/contracts.mjs`; `--max-lines` only lowers the slice line cap when a slice is
rebuilt. Prompting from a stored `slices/<lens-id>.json` still re-bounds the
rendered prompt to the fixed prompt budget, so old or oversized slices cannot
overflow a worker prompt.

## Prompt and slice budgets

Budgets are locked in `src/contracts.mjs` and are not caller-tunable:

| Budget | Value | Scope |
| --- | ---: | --- |
| `MAX_SLICE_LINES` | 450 | Total retained diff lines in a slice |
| `MAX_SLICE_BYTES` | 12,000 | Serialized selected hunks |
| `MAX_HUNK_LINES` | 60 | Lines retained from any single hunk |
| `MAX_PROMPT_BYTES` | 24,000 | Final raw prompt, UTF-8 bytes |
| `MAX_PROMPT_LINES` | 500 | Final raw prompt lines |

`prompt` is deterministic: the same packet/slice and lens always produce
byte-identical output. The trusted rubric, quarantine law, coordinate law, and
the complete JSON output schema (including the intent-alignment body) are always
retained; only passive PR data is shrunk. Omitted diff content is disclosed with
explicit omission notes and retained lines keep their original explicit
coordinates. Quarantine fences stay balanced.

Prompt clipping is **limited diff coverage**, never evidence of a clean
full-diff review. The orchestrator still passes the whole bounded prompt inline
to the worker and reports the limited coverage. A genuinely broken tool
truncation (a prompt clipped mid-schema, missing the output contract, with
unbalanced fences, or above the budgets) must never be forwarded. If the trusted
scaffolding alone cannot fit, `prompt` fails with exit `2` (`budget_exceeded`)
instead of emitting a partial prompt.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | OK |
| `1` | Internal error or transport failure |
| `2` | Validation or schema failure (unsafe input, bad report, budget exceeded) |
| `3` | Not found, or duplicate review refused |
| `4` | Stale `head_sha`; the PR moved since ingest |

These are frozen in `src/contracts.mjs` (`EXIT_CODES`) and never redefined by
callers.

## JSON envelopes

Success:

```json
{ "data": { "schema_version": 1 } }
```

Failure:

```json
{ "error": { "code": "schema_invalid", "message": "Finding requires a non-empty evidence_quote from the diff" } }
```

`details` may be present when a validator can point at a field. Stable error
codes include `invalid_pr_ref`, `invalid_input`, `schema_invalid`,
`budget_exceeded`, `not_found`, `refused`, `duplicate_review`, `stale_head_sha`,
`auth_required`, `transport_error`, and `internal`.

## Review lenses

Thirteen core lenses always run, in two waves:

| Wave | Lens | Focus |
| --- | --- | --- |
| 1 | `intent-alignment` | PR claims vs. diff, scope creep, unfulfilled claims |
| 1 | `security` | Injection, auth, secrets, SSRF/XSS, unsafe deserialization |
| 1 | `data-race-conditions` | TOCTOU, atomicity, unawaited async, ordering |
| 1 | `platform-team` | Cross-OS paths, CI, engine floors, rollout and rollback |
| 1 | `feature-team` | End-to-end workflow, edge cases, recovery states |
| 1 | `api-contract-compat` | Breaking exports, flags, exit codes, schemas |
| 2 | `polymorphism-dry` | Dispatch tables, duplication, coupling |
| 2 | `naming-readability` | Naming, complexity, contract clarity |
| 2 | `code-style` | Repo idioms, dead code, debug leftovers |
| 2 | `testing-verification` | Branch/negative coverage, determinism |
| 2 | `performance-bounds` | Byte caps, timeouts, complexity, memory |
| 2 | `observability-resilience` | Swallowed errors, diagnostics, cleanup |
| 2 | `supply-chain-deps` | New deps, pins, lockfile churn, licenses |

Four conditional lenses activate from changed paths or content hints:

| Lens | Trigger examples |
| --- | --- |
| `accessibility-ux` | `.tsx`, `.jsx`, `.html`, `.css`, client UI files |
| `i18n-localization` | `locale/`, `i18n`, `en.json`, `zh.json` |
| `data-migration` | `.sql`, `migration`, `schema`, `ledger`, `snapshot` |
| `llm-prompt-safety` | `.opencode/`, `agents/`, `commands/`, `SKILL.md`, `AGENTS.md` |

Every lens carries `focus_points` and a non-overlapping
`anti_overlap_boundary`. `selectLensesForFiles` returns the selected IDs and the
reason (`core_always_on` or `trigger:<value>`), and
`partitionLensesIntoWaves` orders by wave and caps parallel dispatch at 12.

## Contracts

`src/contracts.mjs` is the shared truth and is imported, never copied:

- `PRContextPacket` - parsed reference, PR metadata, quarantined text, files,
  hunks, selected lenses, and planned waves.
- `SubagentReviewReport` - one per lens, containing `lens_id`, `head_sha`, and
  validated findings.
- `IntentAlignmentReport` - `verdict`, `has_problem_statement`,
  `has_solution`, `claim_mappings`, `scope_creep_files`, `unfulfilled_claims`,
  and a required `summary`.
- `OrchestratedPRReviewPayload` - final verdict, inline comments, summary
  findings, lens coverage, and the intent report.

Hard invariant: `OrchestratedPRReviewPayload` validation rejects `APPROVE`
whenever the intent verdict is not `ALIGNED`.

## Security and quarantine

- **Zero runtime dependencies.** Node >= 22 built-ins only. No install hooks, no
  transitive supply chain.
- **Zero shell interpolation.** PR references are parsed as data and rejected
  when they contain control characters or shell metacharacters. Nothing is
  passed to a shell.
- **`<untrusted_pr_data>` fencing.** Titles, bodies, commit messages, and diff
  excerpts are normalized, stripped of C0 controls, defanged against fence and
  `<system-reminder>` breakouts, tagged with a SHA-256 digest, and truncated at
  the per-field byte budget.
- **Prototype-pollution guard.** Every validated object rejects `__proto__`,
  `constructor`, and `prototype` recursively.
- **Path safety.** Diff paths are normalized to repository-relative POSIX form
  and traversal segments are rejected.
- **Bounded work.** `MAX_DIFF_BYTES`, `MAX_TEXT_FIELD_BYTES`,
  `MAX_SLICE_LINES`, `MAX_SLICE_BYTES`, `MAX_HUNK_LINES`, `MAX_PROMPT_BYTES`,
  `MAX_PROMPT_LINES`, and `MAX_FINDINGS_PER_LENS` cap every model-facing input.

## Publication

`publish` renders locally by default. Posting requires both `--post` and
`--confirm`, and refuses when:

- the live PR `head_sha` differs from the reviewed `head_sha` (exit `4`);
- a review with the `<!-- hivemind-pr-review:v1 -->` marker already exists for
  that head (exit `3`, duplicates refused);
- authentication is missing (exit `3`, `auth_required`);
- `--post` is passed without `--confirm` (exit `2`, `refused`).

## Testing

```powershell
node plugins/pr-review/src/contracts.mjs --self-check
node --test --test-isolation=none "plugins/pr-review/test/*.test.mjs"
```

The self-check asserts exactly 13 core lenses, 4 conditional lenses, safe PR
reference parsing, quarantine breakout defanging, trigger selection, and wave
caps.