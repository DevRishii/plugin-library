---
description: Adaptive Parallel DAG Swarm - routes by complexity (Tier 1 direct, else Recon -> Contract -> Parallel Builders -> Verify/Audit waves), or executes .opencode/SPEC.md.
agent: hivemind-architect
---

Execute the **Adaptive Parallel DAG Swarm** on this request:
$ARGUMENTS

## 0. Input
- Task = the text above. If it is empty or says to use the spec, and `.opencode/SPEC.md` exists, execute that spec: its Shared Data/API Contracts = Wave 1, its File Ownership Matrix rows = Wave 2 builders, its Verification Criteria = Wave 3. If empty and no spec exists, ask the user for a task and stop.
- Read the ACTIVE STACK TOPOLOGY block in AGENTS.md: note MAX_PARALLEL_SUBAGENTS (cap) and the verification gate roster.

## 1. Route by complexity
- <= 2 files touched -> **Tier 1 direct fast-path**: do it yourself, no subagents, no wave plan. State "Tier 1 direct: <reason>" in one line, then implement and self-check.
- Otherwise -> DAG swarm below.

## 2. Print the Parallel Wave Plan BEFORE firing any batch
Fixed format (example skeleton):

```
PARALLEL WAVE PLAN
Wave 0: Recon [R1..R2]            (only if repo/area unfamiliar; parallel @researcher/@scout)
  R1 @scout      - map auth routes: files, interfaces
  R2 @researcher - existing test conventions
Wave 1: Contract (architect-owned)
  src/types/user.ts, src/db/schema.sql, config/routes.json
Wave 2: Parallel Builders [1..4]
| # | OWNED_FILES              | READ_ONLY_CONTRACTS | ACCEPTANCE_CHECK        |
|---|--------------------------|---------------------|-------------------------|
| 1 | src/api/users.ts         | src/types/user.ts   | tsc --noEmit on file    |
| 2 | src/ui/UserList.tsx      | src/types/user.ts   | tsc + component test    |
| 3 | tests/users.test.ts      | src/types/user.ts   | test file runs green    |
| 4 | src/db/users.repo.ts     | src/db/schema.sql   | tsc --noEmit on file    |
Wave 3: Verify/Audit  [@verifier + @auditor]   (use gate roster from ACTIVE STACK TOPOLOGY)
```

## 3. Rules
- **Single-Message Parallel Tool Batching**: every subagent call in a wave MUST be emitted in ONE assistant message as one parallel tool-call batch. Sequential subagent calls are FORBIDDEN when tasks have no data dependency. The only legal sequencing is between waves (Wave N+1 consumes Wave N output).
- Builders per wave: N = 3-6, never above MAX_PARALLEL_SUBAGENTS. If the ownership matrix has more rows than the cap, run Wave 2 as batches 2a, 2b (each its own single-message batch).
- **Pre-flight**: verify OWNED_FILES sets are pairwise disjoint. Any file needed by 2+ builders moves into Wave 1 (you lock it, builders get it read-only). Fix the plan before firing.
- Each builder prompt carries exactly: OWNED_FILES, READ_ONLY_CONTRACTS, ACCEPTANCE_CHECK. Builders must not edit files outside OWNED_FILES.
- Wave 1 is done by you directly (types/schema/config contracts) before Wave 2 fires.

## 4. After Wave 3
- On failure, re-dispatch only to the owning builder (max 2 attempts per builder), then escalate to @oracle or fix directly as architect.
- Final status report under 200 words: waves run, agents per wave, PASS/FAIL, blockers.
