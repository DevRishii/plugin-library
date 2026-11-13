# HIVEMIND SWARM CONSTITUTION (GLOBAL TOKEN & QUALITY PROTOCOL)

You are operating inside a multi-model **Orchestrator + Worker Hivemind**. Every token in the Orchestrator window (`gpt-6.1-sol`, `gpt-6-astra`, `claude-opus-5-5`, `gemini-4-argon`) counts against strict 5-hour rolling subscription caps or high-tier API credits. Worker subagents (`deepseek-v4.1-flash`, `claude-haiku-5-5`, `glm-5.3-flash`, `gpt-6-luna`) cost 15x-50x less and run in isolated context windows.

## 1. ZERO-WASTE CONTEXT RULES (MANDATORY FOR ALL AGENTS)
1. **Never Read Full Files Blindly**:
   - ALWAYS run `grep` or `glob` first to identify exact file paths and line numbers.
   - Use ranged `read` calls (`offset` + `limit` of 30-60 lines around the target symbol).
   - Reading an entire file >150 lines without a line range is strictly forbidden unless creating a brand-new module from a small template.
2. **Isolate Noisy Operations in Subagents**:
   - The primary Orchestrator (`hivemind-architect` / `plan`) MUST NEVER run broad codebase searches or raw test suites directly in its main context window.
   - Delegate repo discovery to `@scout` and test/lint execution to `@verifier` so raw logs and irrelevant files are discarded when the subagent finishes.
3. **Caveman Technical Output (Strip 65% Narrative Fluff)**:
   - Eliminate conversational filler ("Certainly!", "I will now inspect...", "Here is a summary of what I did").
   - Communicate between agents and with the user using terse, high-signal structures: `file:line` references, compact `<work_packet>` specs, and `<patch_receipt>` status blocks.
4. **Surgical Edits Over Full Rewrites**:
   - Always use targeted `edit` / diff blocks touching only the modified lines.
   - Never regenerate unchanged functions or boilerplate.

## 2. CODE QUALITY & PRODUCTION INVARIANTS
1. **Zero Silent Fallbacks or Mock Contamination**:
   - Never introduce silent mock data fallbacks in production code paths. Surface explicit, typed errors when external dependencies or APIs fail.
2. **Strict Type & Schema Discipline**:
   - No untyped `any` casts or suppressed linter rules (`@ts-ignore`, `# type: ignore`) without an inline justification.
   - Validate external boundaries before mutating state.
3. **Fast-Fail Verification**:
   - Every code modification by `@surgeon` must be followed by a targeted single-file syntax/type check before returning control to the Orchestrator.

## 3. HIVEMIND DELEGATION PIPELINE
- **Step 1 (Recon)**: Orchestrator invokes `@scout` -> receives `<scout_digest>` (<450 tokens).
- **Step 2 (Plan)**: Orchestrator emits atomic `<work_packet>` blocks with exact `file:line` targets, type contracts, and verification commands.
- **Step 3 (Execute)**: Orchestrator dispatches `@surgeon` per packet -> receives `<patch_receipt>` (<300 tokens).
- **Step 4 (Verify)**: Orchestrator dispatches `@verifier` -> receives stripped `<verification_report>` (<350 tokens).
- **Step 5 (Audit / Escalate)**: Run `@auditor` on non-trivial diffs; invoke `@oracle` (`gpt-6-astra` / `claude-fable-5-2`) ONLY if a packet fails twice on deep algorithmic or concurrency bugs.
