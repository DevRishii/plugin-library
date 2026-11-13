---
name: fleet-orchestration
description: 'Use at the start of any non-trivial Fleet-mode task to plan and run a subagent swarm: prompt-to-brief sharpening, instrument and model routing, workflow-script patterns, budget tiers, verification, and synthesis.'
---

# Fleet orchestration

Fleet mode converts a user prompt into an optimized delegation brief, dispatches the widest useful swarm, verifies the work, and returns one synthesized answer. Token and credit efficiency are requirements, not preferences: a fleet that spends twice the tokens for the same answer is a failure.

## 1. Sharpen the prompt into a Fleet brief

Fill this in before delegating. Keep it compact; it is a working document, not an essay.

```
Goal:              one sentence, observable outcome
Deliverables:      files / answers / decisions, with acceptance criteria
Constraints:       stack, paths, APIs, budgets, deadline, do-not-touch areas
Tripwire Check:    Review /tripwire/board before fan-out. If a file is held, do not proceed; report the holder.
Unknowns:          what must be discovered first, and by which unit
Work units (independent, disjoint write scopes):
  U1: ...        -> model: flash/low;  output: schema or bullets
  U2: ...        -> model: flash/high; output: ...
  U3: ...        -> model: v4-pro/high; output: ...
Budget:            N children max, wave plan, stop condition
```

Rules for units:

- Units must have disjoint `write_scopes`. If a unit must write to a scope held by another session (check `/tripwire/board`), stop and report.
- Conflict Policy: Report the holder and do not `claim` or retry automatically.

---

- One unit = one child call whose result can be judged done on its own.
- Units must be independent (no shared files, no ordering) or explicitly staged as a pipeline.
- A unit that needs another unit's result is a later stage, never a parallel call.
- Every unit prompt carries: scope, exact paths, output contract, length bound, and budget.
- If a unit is context-dependent on you, do it yourself; delegation should not become a game of telephone.
- Resolve ambiguity with cheap reads first. Ask the user only for decisions that are genuinely theirs.
- Before the first big fan-out, show the brief compactly in chat (goal, units, budget) — 5–10 lines, not a long plan.

## 2. Choose the instrument

| Situation | Instrument |
|---|---|
| 1–2 focused delegations | `subagent` (fresh) or `subagent_fork` (inherits this conversation) |
| 3+ independent units, or structured results to merge | `workflow` tool |
| Durable multi-turn collaboration, shared tree, task DAG, work that builds on itself | Agent Teams (`spawn_teammate`, `team_task_*`) |
| Trivial, single-file, or deeply contextual work | do it yourself |
| Broad research with no known shape | workflow pipeline: angles -> extraction -> synthesis |
| Long verification/audit | workflow map/reduce with an adversarial pass |

Rules:

- Prefer continuing an existing child/teammate when follow-up builds on its context; a fresh brief costs more than a follow-up message.
- Do not use Agent Teams for work one `subagent` call can finish, and do not use the workflow tool for two delegations.
- Do not mix a full-concurrency workflow run with extra direct `subagent` calls: the runtime admits at most 10 active child agents and a start beyond that fails with `ACTIVATION_LIMIT_REACHED`. Leave one slot free when you expect to delegate directly meanwhile.
- Treat workflow children as leaf workers. They inherit tools and can delegate again, but nested fan-out burns the same capacity; only instruct recursion when the task explicitly needs it.

## 3. Model routing (the main credit lever)

Provider `deepseek-account`, routes verified with `list_subagent_models`. The
`subagent` tool takes `provider` + `model` together, optionally with
`reasoning_effort`. The workflow `agent()` hook takes `provider`/`model`
overrides only, so workflow children inherit the lead's reasoning effort: keep
mechanical waves on a cheap model, and prefer `subagent` when you need a low
effort on just a few units.

| Unit kind | Route | Effort |
|---|---|---|
| Mechanical edits, grep-and-report, inventories, formatting, link checks, test running | `deepseek-flash` | `off` or `low` |
| Default research, extraction, most code units, reviews | `deepseek-flash` | `high` (default) |
| Architecture, ambiguous debugging, cross-cutting design, judging conflicts | `deepseek-v4-pro` | `high` |
| Single hardest adjudication, final synthesis of conflicting child claims | `deepseek-v4-pro` | `max` |

Never route routine work to `deepseek-v4-pro`; never send bulk units to max effort. When unsure which route exists, call `list_subagent_models` once instead of guessing.

## 4. Budget tiers

Pick the smallest tier that satisfies the acceptance criteria, state it in the brief, and stop when the criteria are met.

| Tier | Children | Shape |
|---|---|---|
| Light | <= 4 | one wave, flash only; small reviews, quick research |
| Standard (default) | 5–12 | one or two waves, mostly flash + 1–2 pro units; audits, feature research, module sweeps |
| Deep | 13–32 | staged pipeline plus adversarial verification; migrations, broad research programs |
| Max | 33–64 | only when the user asks for exhaustive coverage; split into phases and report progress. The per-run engine stop is 96 children. |

- Always reserve capacity and budget for a verification phase and one synthesis pass.
- If the work units outnumber the budget, batch items (e.g. 5–10 files per child) rather than one child per item.
- A second wave must have a stated reason (new unknown surfaced, verification found gaps). "More coverage" alone is not a reason.
- Report the fleet ledger at the end: children run, models used, and any units that stayed unresolved.

## 5. Writing workflow scripts

The `workflow` tool runs a JavaScript body with no filesystem, network, or timer APIs; the children do the work.

- `agent(prompt, { schema, label, phase, provider, model })` returns the child's text, or a validated object when `schema` is given; it resolves `null` on child failure.
- Schemas are object-rooted and support only `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `oneOf`. Keep them small and bounded; long free-text fields defeat the point.
- `pipeline(items, ...stages)` runs per-item stages independently with no barrier — prefer it for multi-stage work. `parallel(thunks)` is a barrier: use it only when a stage genuinely needs every prior result together.
- `phase(title)` groups progress; `log(message)` narrates; `args` is the verbatim tool input (wrap lists as `{ files: [...] }`).
- Children share the workspace: point them at paths and let them read, instead of pasting file contents into prompts.
- Filter failed units with `.filter(Boolean)` and report them; do not fail the whole run over one item. Retry a failed unit once with a sharper prompt, then mark it unresolved.
- Return a compact aggregate: counts, findings with `path:line` and a short summary, open questions, and the unit/model ledger. Never return raw child transcripts.
- Use `run_in_background: true` only when you have independent work to do while it runs; collect with `job_output`.

### Pattern A — parallel audit

```js
phase('audit')
const results = await parallel(args.units.map((unit) => () => agent(
  `Audit ${unit.path} for ${args.focus}. Return findings only, each with path, line, severity, and <=25-word summary. Do not edit files.`,
  { label: unit.path, model: 'deepseek-flash', schema: {
      type: 'object', additionalProperties: false,
      properties: {
        path: { type: 'string' },
        findings: { type: 'array', items: { type: 'object', additionalProperties: false,
          properties: { line: { type: 'integer' }, severity: { type: 'string', enum: ['high','medium','low'] }, summary: { type: 'string' } },
          required: ['line','severity','summary'] } }
      }, required: ['path','findings'] } })))
const findings = results.filter(Boolean).flatMap((r) => r.findings.map((f) => ({ ...f, path: r.path })))
return { audited: results.filter(Boolean).length, failed: results.filter((r) => !r).length, findings }
```

### Pattern B — implement then verify (no barrier between stages)

```js
phase('implement')
const outcomes = await pipeline(args.units,
  (unit) => agent(`Implement ${unit.change} in ${unit.path}. Run its focused test. Return changed files and test result.`,
    { label: unit.id, schema: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string' }, changed: { type: 'array', items: { type: 'string' } }, test: { type: 'string' }, notes: { type: 'string' } },
        required: ['id','changed','test'] } }),
  (impl) => agent(`Review the change to ${impl.id}: ${impl.changed.join(', ')}. Verify the test claim and report only real problems.`,
    { label: `verify:${impl.id}`, schema: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string' }, ok: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } } },
        required: ['id','ok','problems'] } }))
return outcomes.filter(Boolean)
```

Other useful patterns: multi-angle research (one child per question, schema `{ claims, sources, confidence }`), adversarial review (reviewers with distinct lenses — correctness, security, tests, performance), and discover-then-deepen (wave 1 broad scan, wave 2 one child per hotspot).

## 6. Agent Teams playbook

Use teams when collaboration is durable and the tree is shared.

- Spawn only for real roles; the profile allows up to 8 members and 256 shared tasks. Give each teammate a role, owned paths, and an explicit deliverable.
- Create shared tasks with `write_scopes` and `blocked_by` for ordering. Teammates claim with the current revision, do the work, then complete.
- Keep write scopes disjoint; overlap is advisory, not a lock, so treat it as a bug in the plan.
- The Lead owns wiring, decisions, integration, and tests — never delegate the final judgment.
- `wait_agent` never wakes inactive members and reports no progress when none are running: re-list agents and tasks, wake a required inactive teammate with `send_message`, then wait again.
- Teammates do not consume the subagent concurrency pool, so a team plus a workflow run is allowed — but budget both.

## 7. Verification and synthesis

- Every child claim that gates the deliverable gets checked: read the file, run the command, or ask a second child to falsify it.
- Run the project's own tests, lint, or build yourself before claiming success.
- Deduplicate findings, rank by severity/impact, and keep file paths with line numbers.
- Integrate edits yourself when multiple children touched related code; never trust "it should be fine".
- Final answer: what was done, evidence (commands and results), unresolved issues, and the fleet ledger. Keep it shorter than the work it describes.

## 8. Anti-waste checklist before firing

- Is at least one unit genuinely independent? If not, skip the swarm.
- Does every prompt carry paths, contract, length bound, and budget? Vague prompts cost more in retries than they save.
- Do any two units overlap in scope? Merge them.
- Is each unit on the cheapest route that can do it?
- Are results bounded by schemas or explicit length caps?
- Is a second wave justified by the acceptance criteria? If not, stop and synthesize.
- Would a direct answer cost less than the orchestration overhead? Then just answer.
