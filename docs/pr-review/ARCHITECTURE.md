# PR Review Swarm Architecture

`/pr-review [pr-link]` is a Hivemind swarm command, not a single reviewer
prompt. The command owns orchestration; `@local/pr-review` owns every
deterministic step. No stage trusts model prose without a schema and an
evidence check.

## DAG

```
                      /pr-review <pr-link>
                               |
                               v
                    +----------------------+
                    |  pr-review ingest    |
                    |  parsePrRef          |
                    |  GitHub metadata+diff|
                    |  quarantine fields   |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    |   PRContextPacket    |
                    |  pr_meta, files,     |
                    |  hunks, fences,      |
                    |  selected_lenses,    |
                    |  waves[]             |
                    +----------+-----------+
                               |
             selectLensesForFiles (13 core + triggered)
             partitionLensesIntoWaves (<= 12 per wave)
                               |
        +----------+-----------+-----------+----------+
        |          |           |           |          |
        v          v           v           v          v
  @pr-reviewer @pr-reviewer @pr-reviewer @pr-reviewer ... (parallel)
   lens wave 1  lens wave 1  lens wave 1  lens wave 1
        |          |           |           |          |
        +----------+-----+-----+-----+-----+----------+
                         |
                         v
              SubagentReviewReport per lens
              (lens_id, head_sha, findings[])
                         |
                         v
              +----------------------+
              |  Evidence verifier   |
              |  quote exists in     |
              |  hunk, line range    |
              |  and side valid      |
              +----------+-----------+
                         |
                         v
              +----------------------+
              | IntentAlignmentReport|
              | ALIGNED / PARTIAL /  |
              | MISALIGNED /         |
              | UNDETERMINABLE       |
              +----------+-----------+
                         |
                         v
              +----------------------+
              |     synthesize       |
              | corroborative dedupe |
              | severity/confidence  |
              | merge + intent gate  |
              +----------+-----------+
                         |
                         v
           OrchestratedPRReviewPayload
           verdict, inline_comments[],
           summary_findings[], lens_coverage[],
           intent, head_sha
                         |
              +----------+----------+
              |                     |
              v                     v
        render Markdown        render JSON
              |                     |
              +----------+----------+
                         |
                         v
              +----------------------+
              |       publish        |
              | dry run by default   |
              | --post --confirm     |
              | stale/duplicate guard|
              +----------+-----------+
                         |
                         v
           GitHub Pull Request Review API
           marker: <!-- hivemind-pr-review:v1 -->
```

## Dataflow

| Stage | Input | Output | Owner |
| --- | --- | --- | --- |
| Ingest | PR URL or `owner/repo#n` | `PRContextPacket` | `src/ingest.mjs` + `contracts.mjs` |
| Lens selection | Changed paths, content hints | `selected_lenses[]`, reasons | `selectLensesForFiles` |
| Wave planning | Selected IDs, max parallel | `waves[][]` (cap 12) | `partitionLensesIntoWaves` |
| Prompt | Packet slice + lens | Fenced prompt with output schema | `src/slicer.mjs` |
| Review | Prompt + diff slice | `SubagentReviewReport` | `@pr-reviewer` |
| Validation | Report + hunks | Verified report or exit `2` | `validateReport` |
| Intent gate | PR text + diff | `IntentAlignmentReport` | intent lens + validator |
| Synthesis | Verified reports | `OrchestratedPRReviewPayload` | `src/synthesize.mjs` |
| Render | Payload | Markdown or JSON | `src/synthesize.mjs` |
| Publish | Payload | GitHub review or dry-run output | `src/publish.mjs` |

## Trust boundaries

```
untrusted: PR title, body, commit messages, diff text, file names
      |
      |  normalize, strip controls, defang fences, digest, truncate
      v
trusted envelope: <untrusted_pr_data label="..." sha256="...">
      |
      |  model output is untrusted again
      v
trusted only after: schema validation + quote/anchor evidence check
```

1. **Ingestion boundary.** Everything fetched from GitHub is untrusted. The
   packet stores both the sanitized text and the digests, never raw injection
   vectors.
2. **Prompt boundary.** Each `@pr-reviewer` prompt contains one lens, one
   bounded slice, and the quarantine fence. Prompts never interpolate PR text
   into shell commands.
3. **Report boundary.** A report is data until `validate-report` confirms the
   schema, lens ID, `head_sha`, severity/confidence enums, and that each
   `evidence_quote` appears in the cited hunk on the cited side.
4. **Publication boundary.** Only a validated `OrchestratedPRReviewPayload` can
   reach `publish`. Posting needs explicit `--post --confirm`; dry run is the
   default.

## Contracts

| Contract | Required fields | Guard |
| --- | --- | --- |
| `PRContextPacket` | `schema_version`, `pr_ref`, `pr_meta.head_sha/base_sha`, `files[]`, `hunks[]`, `selected_lenses[]`, `waves[]` | SHA format, known lenses, safe paths |
| `SubagentReviewReport` | `schema_version`, `lens_id`, `head_sha`, `findings[]` | Known lens, max 25 findings |
| `ReviewFinding` | `lens_id`, `severity`, `confidence`, `path`, `line_start`, `line_end`, `side`, `title`, `body`, `evidence_quote` | Enums, positive line range, non-empty quote |
| `IntentAlignmentReport` | `verdict`, `has_problem_statement`, `has_solution`, `claim_mappings[]`, `scope_creep_files[]`, `unfulfilled_claims[]`, `summary` | Enum verdict, non-empty summary |
| `OrchestratedPRReviewPayload` | `schema_version`, `pr_ref`, `head_sha`, `verdict`, `intent`, `inline_comments[]`, `summary_findings[]`, `lens_coverage[]` | Non-`ALIGNED` intent cannot `APPROVE` |

`schema_version` is `1`. Unknown versions fail with exit `2`.

## Failure and refusal model

| Condition | Exit | Code |
| --- | ---: | --- |
| OK | 0 | - |
| Internal error or transport failure | 1 | `internal`, `transport_error` |
| Unsafe PR ref, schema violation, budget exceeded, unconfirmed `--post` | 2 | `invalid_pr_ref`, `schema_invalid`, `budget_exceeded`, `refused` |
| Missing PR, missing auth, duplicate review | 3 | `not_found`, `auth_required`, `duplicate_review` |
| PR head changed since ingest | 4 | `stale_head_sha` |

Refusals are explicit and deterministic. The swarm never downgrades a stale or
duplicate review into a silent success.

## Parallelism and budgets

- Core lens waves: wave 1 (six lenses), wave 2 (seven lenses), then conditional
  wave 3. `partitionLensesIntoWaves` preserves wave order and caps each chunk.
- `DEFAULT_MAX_PARALLEL` is 6; `HARD_MAX_PARALLEL` is 12.
- `MAX_DIFF_BYTES` 1,500,000; `MAX_TEXT_FIELD_BYTES` 32,768;
  `MAX_SLICE_LINES` 450; `MAX_FINDINGS_PER_LENS` 25.
- Findings are deduplicated by path, line range, and normalized title, keeping
  the highest severity and confidence. Corroboration across lenses raises
  confidence but never invents a new finding.