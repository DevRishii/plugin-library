---
name: token-discipline
description: Enforces surgical line-range file reads, structured subagent handoff packets, log stripping, and zero-fluff responses to cut token consumption by 60-80%. Load when orchestrating multi-file changes or when quota preservation is critical.
license: MIT
---

# Token Discipline & Handoff Protocol

## 1. Ranged Read Protocol
- Step 1: `grep` for symbol definition or usage (`grep -n "functionName" src/`).
- Step 2: `read` only `line - 10` through `line + 45`.
- Step 3: Never dump full lockfiles, build artifacts, minified bundles, or migration histories into context.

## 2. Canonical Inter-Agent Schemas

### A. `<scout_digest>` (Emitted by `@scout`, max 450 tokens)
```xml
<scout_digest>
  <target file="src/services/auth.ts" lines="42-88">
    <signature>export async function verifySession(token: string): Promise&lt;SessionUser&gt;</signature>
    <deps>Imports: db (src/db/index.ts:12), AuthError (src/errors.ts:8)</deps>
    <notes>Throws AuthError on expired JWT; called by middleware/requireAuth.ts:19.</notes>
  </target>
</scout_digest>
```

### B. `<work_packet>` (Emitted by `@hivemind-architect` to `@surgeon`)
```xml
<work_packet id="PKT-01">
  <file path="src/services/auth.ts" lines="42-88" />
  <objective>Add token refresh grace window (60s) without mutating SessionUser return type.</objective>
  <constraints>Preserve existing AuthError codes; do not modify middleware callers.</constraints>
  <verify_cmd>npx tsc --noEmit src/services/auth.ts</verify_cmd>
</work_packet>
```

### C. `<patch_receipt>` (Emitted by `@surgeon`, max 300 tokens)
```xml
<patch_receipt id="PKT-01" status="PASS">
  <changed file="src/services/auth.ts" lines="54-71" delta="+9/-2" />
  <verify cmd="npx tsc --noEmit src/services/auth.ts" exit_code="0" />
  <summary>Added 60s clock-skew tolerance in verifySession JWT check.</summary>
</patch_receipt>
```

### D. `<verification_report>` (Emitted by `@verifier`, max 350 tokens)
```xml
<verification_report status="FAIL">
  <cmd>npm test -- tests/auth.test.ts</cmd>
  <failures count="1">
    <fail test="rejects token expired >60s" loc="src/services/auth.ts:63">
      Expected AuthError(EXPIRED), received SessionUser. (Comparison used ms instead of seconds).
    </fail>
  </failures>
  <fix_hint>Multiply graceWindowSec by 1000 at src/services/auth.ts:61.</fix_hint>
</verification_report>
```
