# Core Lens Rubrics (13 always-on lenses)

One specialist worker per lens. Each worker reads only its own rubric, its own
`DiffSlice`, and the quarantined PR context. A rubric's `Boundary` line is a hard stop:
defects outside it belong to another lens and must not be reported here.

Severity anchors used by every rubric:

- `BLOCKER` - data loss, security exploit, secret exposure, guaranteed production break,
  or a broken public contract shipped to users.
- `HIGH` - realistic bug, regression, contract drift, or resource leak under normal use.
- `MEDIUM` - latent bug, meaningful maintainability or operability risk.
- `LOW` / `NIT` - minor quality, style, or taste; never blocks a merge.

Evidence requirement for every finding: exact `[NEW:<line>]` / `[OLD:<line>]` anchor plus
a verbatim `evidence_quote` from those lines. No anchor, no finding.

---

## 1. `intent-alignment` - Intent vs. Code-Intent Alignment
- **Owns:** PR title, Problem Statement, and Solution claims compared against the actual
  diff; scope creep (files/behaviour changed with no stated justification); unfulfilled
  claims; contradictions between description prose and observable runtime behaviour.
- **Boundary:** No style, naming, micro-optimization, or test-coverage commentary.
- **BLOCKER / HIGH signals:** a claimed fix that is absent from the diff; a behaviour change
  that contradicts the stated contract; refactors or dependency swaps never mentioned.
- **Extra output:** always emit the `intent_alignment` object
  (`ALIGNED | PARTIAL | MISALIGNED | UNDETERMINABLE`, `claim_mappings[]`,
  `scope_creep_files[]`, `unfulfilled_claims[]`, `summary`). No Problem Statement and no
  Solution section means `UNDETERMINABLE`, never `ALIGNED`.

## 2. `security` - Security & Trust Boundaries
- **Owns:** injection (command, SQL, template, prompt, header), authn/authz gaps, secret and
  token leakage, SSRF/XSS/CSRF, path traversal, symlink escape, prototype pollution, unsafe
  deserialization, permissive CORS, TLS/certificate weakening, and unvalidated external input.
- **Boundary:** Not exploitability-neutral hardening taste (that is a LOW here), not
  dependency provenance (`supply-chain-deps`), not prompt-permission design
  (`llm-prompt-safety`).
- **BLOCKER / HIGH signals:** untrusted text reaching a shell/query/eval sink; missing
  authorization on a privileged path; credentials logged or committed; sandbox or allowlist
  bypass; quarantine fence breakable from PR data.
- **Evidence:** the sink plus the tainted source line; quote the exact sink expression.

## 3. `data-race-conditions` - Data Integrity & Concurrency
- **Owns:** TOCTOU windows, concurrent file/DB writes, missing atomic rename or lock/lease
  fencing, unawaited promises, lost async rejections, event-ordering hazards, stale-state
  reads, non-idempotent retries, partial-write corruption, and transaction boundary gaps.
- **Boundary:** Not single-threaded logic bugs (`feature-team`) and not raw throughput
  (`performance-bounds`).
- **BLOCKER / HIGH signals:** read-modify-write over shared state without atomicity; two
  writers to one journal/manifest; `Promise` returned without `await` on a failure path;
  retry that double-applies a side effect.
- **Evidence:** both racing sites or the un-awaited call, plus the state it mutates.

## 4. `platform-team` - Platform, Infra & Cross-OS Portability
- **Owns:** Windows/macOS/Linux path, shell, line-ending, and process-spawning differences;
  build/installer/CI wiring; Node or runtime engine floors; environment configuration;
  rollout and rollback simplicity; workspace and filesystem hygiene.
- **Boundary:** Not application logic and not public API shape.
- **BLOCKER / HIGH signals:** POSIX-only path or shell syntax in a cross-platform script;
  installer that copies nothing or silently overwrites user files; unpinned runtime floor
  the code violates; CI step that cannot run on the declared matrix.
- **Evidence:** the offending line plus the platform assumption it breaks.

## 5. `feature-team` - Feature Completeness & User Workflow
- **Owns:** end-to-end workflow correctness, empty/error/loading/recovery states, domain
  invariants, CLI/UI ergonomics, actionable user feedback, and caller-expectation seams.
- **Boundary:** Not public schema/CLI contract stability (`api-contract-compat`) and not
  rendering accessibility (`accessibility-ux`).
- **BLOCKER / HIGH signals:** the happy path throws on a normal input; a required state is
  unreachable; errors surface as success; a documented flag or shortcut does nothing.
- **Evidence:** the branch that mishandles the state, quoted from the hunk.

## 6. `api-contract-compat` - API, Schema & Backwards Compatibility
- **Owns:** breaking changes to exported functions, CLI flags, exit codes, JSON envelopes,
  and schemas; version gating; `schema_version` discipline; caller migration paths; drift
  between declared types/schemas and runtime payloads.
- **Boundary:** Not internal duplication (`polymorphism-dry`) and not naming taste.
- **BLOCKER / HIGH signals:** removed/renamed export without a version bump; exit-code or
  envelope shape change callers rely on; validator that accepts payloads the writer cannot
  produce; optional field silently required.
- **Evidence:** the changed signature/payload plus the consumer or declared schema.

## 7. `polymorphism-dry` - Polymorphism, DRY & Modular Design
- **Owns:** sprawling type-switch/if-else ladders better served by registries, strategy
  tables, or polymorphism; copy-pasted logic or duplicated constants that will drift;
  premature or leaky abstractions, tight coupling, single-responsibility violations.
- **Boundary:** Not formatting (`code-style`) and not identifier clarity
  (`naming-readability`).
- **BLOCKER / HIGH signals:** the same security or contract rule duplicated in two places
  where one will drift; dispatch ladder that already misses a registered case.
- **Evidence:** both duplicated blocks or the ladder plus the missing branch.

## 8. `naming-readability` - Naming & Developer Readability
- **Owns:** misleading, ambiguous, or inconsistent identifiers, flags, and file names;
  high cognitive complexity, deep nesting, magic numbers/booleans; module entrypoint
  clarity; missing contract docs for non-obvious behaviour.
- **Boundary:** Not repo idiom compliance (`code-style`) and not structural redesign
  (`polymorphism-dry`).
- **BLOCKER / HIGH signals:** a name that inverts behaviour (e.g. `safe` that mutates);
  a boolean flag whose polarity is unreadable at the call site and already misused.
- **Evidence:** the declaration and one call site that reads wrongly.

## 9. `code-style` - Code Style & Repository Idioms
- **Owns:** adherence to repository ESM/CommonJS, import ordering, and error-handling
  idioms; dead code, unused exports/variables, leftover debug artifacts, suppressed lints;
  consistency with sibling packages and repository hygiene.
- **Boundary:** Not naming semantics or architecture; style alone is never more than LOW
  unless it hides a real defect.
- **BLOCKER / HIGH signals:** dead code path that still ships side effects; stray debug
  output or temp artifact committed; suppression that hides an error path.
- **Evidence:** the offending statement and the sibling convention it violates.

## 10. `testing-verification` - Test Adequacy & Edge-Case Verification
- **Owns:** coverage of changed branches, negative/failure paths, boundary inputs,
  regressions; test determinism (no flaky sleeps, wall-clock races, live network, temp
  leaks); assertions that verify behaviour instead of tautological mocks.
- **Boundary:** Not production error handling (`observability-resilience`).
- **BLOCKER / HIGH signals:** a changed branch with no test at all; a test that would pass
  with the fix reverted; a suite that depends on network, clock, or execution order.
- **Evidence:** the untested branch or the tautological assertion, quoted.

## 11. `performance-bounds` - Performance, Memory & Resource Bounds
- **Owns:** unbounded file/stream/response reads without byte caps or timeouts; quadratic
  loops, redundant synchronous I/O, N+1 fetches, memory retention; token/payload
  amplification on large diffs or repositories.
- **Boundary:** Not correctness of the result and not concurrency ordering.
- **BLOCKER / HIGH signals:** whole-repo or whole-diff buffering with no cap on user input;
  nested scan over unbounded file lists in a hot path; retained buffers across runs.
- **Evidence:** the unbounded read or loop and the missing cap.

## 12. `observability-resilience` - Error Handling, Observability & Resilience
- **Owns:** silent catch blocks, swallowed errors, fake fallback success on external
  failure; typed error codes, actionable diagnostics, deterministic exit codes; cleanup of
  temp files, handles, and child processes on failure.
- **Boundary:** Not whether a feature is complete (`feature-team`) and not exit-code
  compatibility for callers (`api-contract-compat`).
- **BLOCKER / HIGH signals:** network/API failure reported as success; `catch {}` around a
  mutating operation; temp dir or child process leaked on the error path.
- **Evidence:** the catch/cleanup site plus the failure it hides.

## 13. `supply-chain-deps` - Dependencies & Supply-Chain Hygiene
- **Owns:** unnecessary new runtime dependencies where Node built-ins suffice; unpinned
  versions, lockfile churn, postinstall scripts, license risk; undocumented external binary
  or network assumptions in manifests.
- **Boundary:** Not import style (`code-style`) and not runtime cost of an existing dep
  (`performance-bounds`).
- **BLOCKER / HIGH signals:** a postinstall script added from a new source; a lockfile
  rewritten for an unrelated file; a dependency that executes downloaded code at import
  time; license incompatible with the repository.
- **Evidence:** the manifest/lockfile hunk, quoted, plus the import that needs it.