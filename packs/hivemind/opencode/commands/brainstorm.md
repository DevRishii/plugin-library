---
description: Turn a raw thought dump into .opencode/SPEC.md via @spec-architect (contracts, ownership matrix, verification), then offer to launch /swarm on it.
agent: hivemind-architect
---

Raw thought dump (verbatim):
$ARGUMENTS

## Procedure
1. If the dump above is empty, ask the user for their thought dump and stop.
2. Make ONE call to `@spec-architect`, passing the dump above VERBATIM (unedited, not summarized, not reordered). Instruct it to compile the dump into `.opencode/SPEC.md` with sections: Goal & Non-Goals, Shared Data/API Contracts, File Ownership Matrix (disjoint builder workstreams), Verification Criteria, Open Questions.
3. You must NOT write the spec yourself and must NOT start implementing.
4. When the subagent returns, print a compact summary:
   - spec path
   - contract files
   - one line per workstream (builder # -> owned files)
   - open questions
5. If any open question changes contracts, ask those first and wait for answers (relay them to @spec-architect to update the spec if needed) before offering launch.
6. Then ask exactly: "Launch /swarm on .opencode/SPEC.md now? (yes / edit first)"
   - yes -> proceed as `/swarm` would using the spec: print the Parallel Wave Plan (Wave 1 = spec contracts, Wave 2 = ownership matrix rows as parallel builders in single-message batches, Wave 3 = verification criteria and gate roster from the ACTIVE STACK TOPOLOGY block), then fire the batches.
   - edit first -> stop and wait for the user.
