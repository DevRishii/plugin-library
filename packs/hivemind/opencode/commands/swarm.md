---
description: Execute a full Hivemind Swarm cycle (Scout -> Plan Packets -> Surgeon -> Verifier -> Auditor) on a task with strict token conservation.
agent: hivemind-architect
---

Execute the **Hivemind Swarm Pipeline** on the following request:
$ARGUMENTS

1. Dispatch `@scout` to map only the relevant files, line ranges, and interfaces (`<scout_digest>`).
2. Formulate atomic `<work_packet>` blocks with explicit `file:line` targets and verification commands.
3. Dispatch `@surgeon` for each packet (`<patch_receipt>`).
4. Dispatch `@verifier` to run scoped tests and typechecks (`<verification_report>`).
5. Dispatch `@auditor` on the final diff and report the final status in under 200 words.
