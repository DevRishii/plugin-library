## Problem Statement

Reviewing a pull request with a single model pass produces confident prose, but
it is a poor substitute for a real review board. Four failure modes show up
again and again:

- **Single-pass tunnel vision.** One reviewer prompt has to cover security,
  concurrency, portability, API compatibility, tests, performance, and style at
  once. Attention is spread thin, so whole categories of defects are missed and
  the findings that do appear cluster around whatever the diff makes most
  obvious.
- **Intent blindness.** Nothing compares the PR title, Problem Statement, and
  Solution claims against the actual diff. Scope creep, promised fixes that
  never landed, and prose that contradicts runtime behavior all pass silently,
  because the reviewer only looks at code.
- **Untrusted prompt injection.** PR titles, descriptions, commit messages, and
  diff text are attacker-controlled. A single instruction embedded in that text
  (or a forged closing fence) can hijack a naive reviewer prompt, redirect the
  review, or exfiltrate context.
- **Hallucinated, unverified prose.** Review comments routinely cite file paths,
  line numbers, and code quotes that do not exist in the diff. The result is
  noise, broken anchors, and reviewers who stop trusting automated output.

## Solution

This PR adds a Hivemind `/pr-review [pr-link]` orchestrator backed by the
zero-dependency `@local/pr-review` engine. The command turns one PR link into a
quarantined context packet, fans the diff out to specialist reviewer waves,
gates the result on intent alignment and evidence verification, and only then
publishes a GitHub review.

The pipeline has six stages:

1. **Quarantine ingestion.** `pr-review ingest` parses the PR reference with
   `parsePrRef`, fetches metadata and the diff, and wraps every untrusted field
   in `<untrusted_pr_data>` fences with a SHA-256 digest. Fence breakouts and
   control characters are defanged before anything reaches a prompt. The result
   is a versioned `PRContextPacket`.
2. **Parallel specialist waves.** `selectLensesForFiles` always enables the 13
   core lenses and activates the 4 conditional lenses from file/content
   triggers. `partitionLensesIntoWaves` caps each wave (default 6, hard cap 12)
   so `@pr-reviewer` agents run in parallel with disjoint scopes instead of one
   overloaded pass.
3. **First-class intent gate.** A dedicated `IntentAlignmentReport` maps every
   PR claim to a diff location, records unfulfilled claims and scope-creep
   files, and returns `ALIGNED`, `PARTIAL`, `MISALIGNED`, or `UNDETERMINABLE`.
   A non-`ALIGNED` verdict can never produce an `APPROVE`.
4. **Evidence verification.** Every finding must carry a non-empty
   `evidence_quote` plus a path and line range. `validate-report` checks the
   quote against the real diff hunk and rejects stale or invented anchors
   before synthesis.
5. **Corroborative deduplication.** `synthesize` merges `SubagentReviewReport`
   findings, groups duplicates across lenses, keeps the highest severity and
   confidence, and produces one `OrchestratedPRReviewPayload` with lens
   coverage, inline comments, and summary findings.
6. **Safe, idempotent publication.** `publish` is a dry run by default; posting
   requires `--post --confirm`. It refuses duplicate reviews for the same
   `head_sha`, returns exit code 4 when the PR head moved, and stamps every
   review with the `<!-- hivemind-pr-review:v1 -->` marker for idempotency.

## Review Angles & Specialist Lenses

Thirteen core lenses always run:

| Wave | Lens | Focus |
| --- | --- | --- |
| 1 | `intent-alignment` | PR claims vs. diff, scope creep, unfulfilled claims |
| 1 | `security` | Injection, auth, secrets, SSRF/XSS, unsafe deserialization |
| 1 | `data-race-conditions` | TOCTOU, atomicity, unawaited async, ordering |
| 1 | `platform-team` | Windows/macOS/Linux, CI, engines, rollout and rollback |
| 1 | `feature-team` | End-to-end workflow, edge cases, recovery states |
| 1 | `api-contract-compat` | Breaking exports, flags, exit codes, schemas |
| 2 | `polymorphism-dry` | Dispatch tables, duplication, coupling |
| 2 | `naming-readability` | Naming, complexity, contract clarity |
| 2 | `code-style` | Repo idioms, dead code, debug leftovers |
| 2 | `testing-verification` | Branch/negative coverage, determinism |
| 2 | `performance-bounds` | Byte caps, timeouts, complexity, memory |
| 2 | `observability-resilience` | Swallowed errors, diagnostics, cleanup |
| 2 | `supply-chain-deps` | New deps, pins, lockfile churn, licenses |

Four conditional lenses activate on triggers:

| Lens | Trigger examples |
| --- | --- |
| `accessibility-ux` | `.tsx`, `.jsx`, `.html`, `.css`, client UI files |
| `i18n-localization` | `locale/`, `i18n`, `en.json`, `zh.json` |
| `data-migration` | `.sql`, `migration`, `schema`, `ledger`, `snapshot` |
| `llm-prompt-safety` | `.opencode/`, `agents/`, `commands/`, `SKILL.md`, `AGENTS.md` |

## Architecture & Security Guardrails

```
/pr-review <pr-link>
        |
        v
  ingest -> PRContextPacket (quarantined title, body, diff, files, hunks)
        |
        v
  lens selection -> parallel @pr-reviewer waves
        |
        v
  IntentAlignmentReport + evidence verifier
        |
        v
  OrchestratedPRReviewPayload -> render -> publish (dry run by default)
        |
        v
  GitHub Pull Request Review API
```

The engine is deliberately boring and defensive:

- **Zero runtime dependencies.** Only Node >= 22 built-ins (`node:crypto`,
  `node:fs`, `node:url`, `node:https`), so there is no supply-chain surface.
- **Zero shell interpolation.** PR references are parsed and validated as data;
  no command string is ever built from user input.
- **Prompt quarantine.** `<untrusted_pr_data>` fencing with digests, tag
  defanging, CRLF normalization, control-character stripping, and per-field
  byte budgets.
- **Schema discipline.** `schema_version: 1`, prototype-pollution rejection,
  repo-relative path normalization, severity/confidence enums, and explicit exit
  codes.
- **Publication safety.** Dry run unless `--post --confirm`; stale-head refusal
  and duplicate-review refusal; the marker makes reruns idempotent.

## What's Included

- `plugins/pr-review/` - the `@local/pr-review` 0.1.0 engine, CLI, contracts,
  and tests.
- `plugins/pr-review/src/contracts.mjs` - lens registry, exit codes, error
  codes, PR reference parser, quarantine helpers, and schema validators.
- `packs/hivemind/opencode/commands/pr-review.md` - the `/pr-review <pr-link>`
  orchestrator command.
- `packs/hivemind/opencode/agents/pr-reviewer.md` - the specialist reviewer
  agent.
- `packs/hivemind/opencode/skills/pr-review/SKILL.md` - the review skill.
- `docs/pr-review/ARCHITECTURE.md` - DAG and dataflow.
- Catalog updates in `README.md` and `packs/hivemind/README.md`.

## Verification

Run the structural checks from the repository root:

```powershell
node scripts/verify.mjs
npm test
```

`verify.mjs` confirms package shape, declared entries, and hygiene (no secrets,
no personal absolute paths, no local state). The PR review test suite covers PR
reference parsing, quarantine breakout defanging, lens selection and wave caps,
finding/evidence validation, intent-gate invariants, deduplication, dry-run
publication, stale-head and duplicate refusal, and the contract self-check:

```powershell
node plugins/pr-review/src/contracts.mjs --self-check
node --test --test-isolation=none "plugins/pr-review/test/*.test.mjs"
```

Exit codes are stable: `0` ok, `1` internal/transport, `2` validation/schema,
`3` not found or duplicate refused, and `4` stale `head_sha`. Success responses
are `{ "data": ... }`; failures are `{ "error": { "code", "message" } }`.