# Dream Board

The Dream Board is the second tab of the idea-board widget. It holds
AI-generated product dreams that build on your Ideas Board, recent session
history, and project context. A Dreamer agent deepens them on a daily loop; you
review each one and either **Pursue** it (render a build packet and launch a
Fleet buildout) or **Discard** it.

## Where the data lives

All three files sit with the profile's other durable data, written through the
storage service's JSON backend:

| File | Contents |
|---|---|
| `%USERPROFILE%\.dsh\storages\dream_board.json` | Active dreams + board metadata (revision, managed schedule id, run lock) |
| `%USERPROFILE%\.dsh\storages\dream_discards.json` | Discard memory: every discarded, retired, or pursued dream |
| `%USERPROFILE%\.dsh\storages\dream_runs.json` | Run log: the last 40 run summaries and failures |

The Ideas Board stays in `idea_board.json`. The Dreamer reads ideas and session
history; it never writes them.

## Schemas

### Dream (`dream_board.json` → `tables.dreams[id]`)

```json
{
  "id": "drm_1a2b3c4d5e6f",
  "title": "Docket Scribe",
  "pitch": "Draft court docket entries for solo litigators from a filed PDF.",
  "type": "application",
  "problem": "Solo attorneys retype docket entries by hand, and a typo can cost a filing.",
  "targetUser": "Solo litigation attorneys in the US handling 5-30 active matters",
  "value": "Cuts a 20-minute clerical task to a two-minute review.",
  "monetization": "$29/user/month; ~40k solo litigation firms in the US.",
  "competitive": {
    "summary": "Practice-management suites store matters but do not draft docket entries.",
    "competitors": [
      { "name": "Clio", "url": "https://www.clio.com/pricing/", "pricing": "$49-$129/user/month", "gap": "No docket drafting" }
    ]
  },
  "architecture": "Local-first desktop app; court-rule templates compiled to a rules engine; PDF text extraction; Word export.",
  "mvpScope": ["Import a docket PDF", "Generate draft entries", "Review and export to Word"],
  "effort": "4-6 weeks for one developer",
  "sources": {
    "web": [{ "url": "https://example.com/thread", "title": "Thread about docket entry pain" }],
    "ideas": [{ "id": "abc", "title": "Automate court paperwork" }],
    "sessions": [{ "id": "session-...", "title": "Filing workflow cleanup" }]
  },
  "scores": { "value": 5, "niche": 5, "revenue": 4, "feasibility": 4, "fit": 3 },
  "totalScore": 21,
  "iterationCount": 2,
  "status": "ready_for_review",
  "createdAt": 1762345678901,
  "lastRefinedAt": 1762945678901,
  "revisionLog": [
    { "at": 1762945678901, "change": "Added competitor pricing and narrowed the target user." }
  ],
  "tags": ["legal", "b2b"],
  "distinction": ""
}
```

Status values: `incubating`, `ready_for_review`, `pursued`, `discarded`.
`pursued` and `discarded` dreams leave the board and appear only in discard
memory. The board sorts `ready_for_review` first, then total score, then
recency.

Type values: `feature` (extends an existing project), `application` (a
standalone app), `service` (a hosted or API product). The Dreams tab groups by
these three categories, in that order, and falls back to an "Other ideas" group
for an unrecognized value.

A dream **auto-promotes** to `ready_for_review` when it has a problem, a named
target user, at least one competitor, an MVP scope, an architecture outline,
and (for applications and services) a monetization model.

### Discard memory (`dream_discards.json` → `tables.entries[id]`)

```json
{
  "id": "dsc_9f8e7d6c5b4a",
  "dreamId": "drm_1a2b3c4d5e6f",
  "title": "Docket Scribe",
  "summary": "Draft court docket entries for solo litigators from a filed PDF.",
  "mechanics": {
    "problem": "Solo attorneys retype docket entries by hand.",
    "targetUser": "Solo litigation attorneys",
    "approach": "Local-first desktop app with a court-rules engine."
  },
  "tags": ["legal", "b2b"],
  "reason": "Pursued: fleet buildout started (session-...)",
  "outcome": "pursued",
  "date": "2026-11-12T15:04:05.000Z",
  "tokens": ["docket", "entries", "attorneys", "court", "rules"]
}
```

`outcome` is `discarded`, `retired`, or `pursued`. `tokens` is the normalized
concept fingerprint used for dedup, so the check compares meaning rather than
titles.

### Run log (`dream_runs.json` → `tables.runs[id]`)

```json
{
  "id": "run_0a1b2c3d4e5f",
  "at": 1762945678901,
  "sessionId": "session-...",
  "added": ["Claim Review Desk"],
  "refined": ["Docket Scribe"],
  "promoted": ["Docket Scribe"],
  "retired": [],
  "skipped": ["Generic invoice generator (duplicate)"],
  "note": ""
}
```

A failed run writes `added`/`refined`/... as empty arrays and puts the failure
in `note`; a run that dies before `dream_summary` is recorded this way.

## The Dreams tab

- **Grouping:** dreams are grouped into **New features**, **New apps**, and
  **New services**, with an **Other ideas** fallback. Within each group the
  ready-for-review dreams come first, then total score.
- **Labels:** each row shows status, category, iteration count, source count,
  last-refined date, MVP step count, competitor count, and whether web research
  is attached ("2 web sources" or "No web sources yet"). The detail view adds
  created/updated dates, tagged labels, all five score chips, and the full spec.
- **Actions:** the detail view's **Pursue** renders the build packet, then
  launches the Fleet build from it; **Discard** takes an optional one-line
  reason. The `/dream brief` command exposes the packet without launching.
- **Wide view:** the header's expand button switches the card to a bigger
  window with a master-detail layout — the grouped list on the left and the
  selected dream's full spec on the right. Press it again to restore the compact
  card. The choice is saved with the widget layout. Without the wide preset the
  card can be resized from any edge or corner, and the **dock** button moves it
  into the sidebar footer above Settings; both states persist.
- **Doctor run:** the Nightmares tab's toolbar runs the workspace doctor and
  folds its `--nightmares` feed into the backlog. It is the counterpart of this
  tab's run-now control.

## The `/dreamer` agent

The agent preset is declared in `cordis.patch.yml` (`preset-dreamer`, id
`dreamer`) and is used by every scheduled delivery. Its tools:

| Tool | What it can do |
|---|---|
| `dream_context` | Read ideas, recent session activity receipts, a compact active-dream index, the binding pursued history, recent discards, caps, and the run lock |
| `dream_get` | Read one dream's full stored record by id (read-only) |
| `dream_save` | Create/refine one dream; enforces cap, per-run new-dream cap, readiness, dedup, revision log. Refining requires the matching `id` and `title`; unknown ids are rejected |
| `dream_retire` | Retire a dream into discard memory |
| `dream_schedule` | Run the dreamer now, inspect its schedule, or pause/resume it |
| `dream_summary` | Write the run summary and release the lock |
| `web_search`, `web_fetch` | Research only |
| `subagent` | Parallel research |
| `glob`, `grep` | Read-only project context search |

It has **no** shell, write, edit, or apply-patch tool, so it cannot modify
project code, the ideas, or session history. Its writes go only through the
three dream tools. Web queries are generalized; raw private content is never
sent.

### Activity receipts

`dream_context` returns an `activity` block beside `sessions`: for each of the
recent non-subagent sessions, the deterministic Session Diff receipt summarized
to files added/modified/deleted, commands and failures with the first failing
line, open threads, models, and cost. A `rollup` raises recurrence — files
touched in two or more sessions, commands that keep failing, and repeated open
threads.

The digest reads receipts already recorded under `~/.dsh/receipts`, and builds
one from the session log when no receipt exists yet. It is bounded (6 sessions,
4 files, 2 failures, 2 threads each), never calls a model, and reports a session
as unavailable rather than guessing. A receipt built on demand reflects the
workspace at digest time; a stored receipt reflects the session's last recorded
turn. The Dreamer uses the digest as evidence of real friction; it is told to
ignore one-off errors and to cite the session ids in `sources.sessions`.

### Pursued history and the context budget

Pursued dreams are a first-class list (`pursued`) derived from ledger entries
with outcome `pursued`; each row carries the title, one-line pitch, tags, date,
packet path, and Fleet session. Pursued is **binding**: a new or refined dream
is rejected when its normalized title matches, when its pitch overlaps one by
80% or more, or when concept tokens clear the usual similarity bar — even when
the candidate is a thin stub whose token score would otherwise fall below it.
A non-trivial `distinction` is the only bypass, and the tool message says so.

On open, the board retires an active stub (no problem, user, or value) whose
title exactly duplicates a pursued dream, and reports any remaining
`boardWarnings` in the context. `dream_context` also carries a compact
active-dream index — id, title, pitch, status, score, tags, `missing` sections,
`weakest` — instead of full specs; `dream_get` fetches one full record on
demand. Discards are bounded to 30 compact rows, runs to 3, sessions to 6 with
4 messages each.

A run may add at most `caps.maxNewDreamsPerRun` new dreams (default 1). The
prompt and persona tell the Dreamer to deepen at most two existing dreams, fill
`missing` sections first, and add nothing when no candidate clearly beats the
board. The guard is enforced in `dream_save` with code `run-cap`, and a new
dream without a problem and target user is rejected with code `thin`, so token
spend and board size stay quality-driven.

Refining also requires the target identity: `dream_save` rejects an unknown id
(`unknown-id`), a refinement without the target title (`target-required`), and
one whose title does not match that id (`target-mismatch`). This stops a run
from reusing one dream's id for another concept. `dream_summary` records the
saves the session actually made in `actual` and sets `mismatch: true` with a
warning when the reported added/refined lists disagree, so the run log cannot
claim work the store did not see.

Dedup runs on every new save against the discard ledger. A new dream that
matches an *active* dream is rejected too, unless it names that dream in
`mergedFrom` or supplies a `distinction`; this is what keeps duplicate rows off
the board.

### Run lock and caps

- The managed schedule task allows one execution at a time; `schedule.run`
  answers `schedule_execution_pending` instead of overlapping.
- On top of that, `dream_context` takes a two-hour run lock owned by the
  session. A second session sees `locked: true` and must stop; the lock is
  released by `dream_summary` (or by the failure recorder).
- A per-agent guard counts `web_search`/`web_fetch` and `subagent` calls and
  denies calls past `maxWebCalls` / `maxSubagents`.

## The loop

The plugin creates one Schedule task titled **Dreamer run** with
`agentPreset: dreamer` and a daily recurrence. It shows up in the normal
Schedule UI and can be paused, resumed, edited, or run there. The widget's
Dreams tab also has pause/resume/run-now controls. `/dreamer` runs it manually:

```
/dreamer          run now
/dreamer status   schedule + board + last-run summary
/dreamer pause    pause the loop
/dreamer resume   resume the loop
```

## Pursue and build packets

A reviewed dream becomes a **build packet**: a deterministic markdown brief
rendered from the dream, an editable template, and a bounded scan of the project
directory. It contains the objective, target user, non-goals, MVP scope, one
acceptance test per MVP bullet, the repository file map, discovered verification
commands, a human review checklist, and the dream's research context.

**Pursue** (the board button or `/dream brief <id> --attach`) writes
`briefs/<slug>.md` and `briefs/<slug>.checks.json`, then creates a one-shot
`schedule` delivery to a new session with `agentPreset: fleet`, seeded with the
packet, fires it, and deletes the one-shot task. The dream then moves to discard
memory with outcome `pursued`, so later runs never re-propose it.

`/dream brief <id>` without `--attach` writes the same two files and leaves the
dream on the board for review. Regenerating is safe: a check keeps its `pass` or
`fail` status and evidence while its MVP bullet is unchanged, and resets when
the bullet changes. Each check carries a generated `expected` result and a
review hint; replace the expected line with the exact case before the build,
then flip the status and record evidence.

```sh
/dream brief <id>                 # write the packet, keep the dream active
/dream brief <id> --attach        # write it and start the Fleet build
/dream brief <id> --out briefs/x  # choose the output directory
/dream list                       # show active dream ids
```

`briefs/template.md` is seeded on first use and is yours to edit: replace any
documented slot, reorder sections, or add headings. Unknown slots are left in
the output and reported by the command, so a typo stays visible. The template
and every output path must stay inside the project directory.

The scan reads top-level directories, manifests one level down, package scripts
for test/lint/typecheck/build, existing test files three levels deep, the README,
and git state. It is deliberately bounded and is labeled as orientation rather
than a complete file index. When a top-level package name shares words with the
dream, the packet lists it as a possible build target; the Fleet session must
confirm or reject that choice in its plan.

From a terminal, without the app:

```sh
node idea-board/bin/dream-brief.mjs <dream-id> --cwd <project>
node idea-board/bin/dream-brief.mjs --list
```

The CLI reads `%USERPROFILE%\.dsh\storages\dream_board.json` (or `--storage`)
without writing it, and renders the same packet through the same `brief.js`
module.


## Change the schedule, cap, and rubric

The row accepts config; override it in the profile patch
(`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`) and restart the plugin
from Settings → Plugins:

```yaml
- id: idea-board
  name: '@local/idea-board'
  config:
    dailyTime: '08:30'        # local HH:MM (or HH:MM:SS) used by the managed task
    timeZone: America/Chicago # IANA zone
    projectCwd: ''            # Dreamer/Fleet build directory; empty = largest registered workspace
    doctorScript: ''          # dsh-doctor entry point; empty = the workspace sibling
    doctorCwd: ''             # directory the doctor scans; empty = projectCwd
    maxActiveDreams: 12       # active (incubating + ready) dreams
    maxNewDreamsPerRun: 1     # new dreams one run may add (quality over quantity)
    maxWebCalls: 12           # web_search + web_fetch per run
    maxSubagents: 3           # subagent spawns per run
    autoSchedule: true        # false = do not create the daily task on start
```

- **Schedule:** change `dailyTime`/`timeZone`, or edit the task directly in the
  Schedule UI. Editing the task there is not overwritten until the config
  signature changes.
- **Cap:** `maxActiveDreams`. The dreamer sees it in `dream_context` and the
  store rejects extra dreams.
- **New-dream cap:** `maxNewDreamsPerRun` (default 1). The store returns
  `code: run-cap` after the run's first addition, so a run deepens existing
  dreams instead of padding the board. A new dream must also carry a problem
  and a target user; bare title-plus-pitch stubs are rejected with
  `code: thin`.
- **Project directory:** `projectCwd` sets where a manual Dreamer session, the
  repository scan, and a Pursue Fleet session work. Empty picks the registered
  workspace with the most sessions; set it explicitly if you build from another
  project. Packets are written under its `briefs/` directory.
- **Rubric:** the five dimensions and their hints live in `RUBRIC` in
  `dreams.js`; the dreamer persona in `cordis.patch.yml` states the quality bar.
  Keep the two consistent when you change either.

## Assumptions (v1)

- No dedicated memory-file convention exists in this workspace, so the discard
  ledger uses the profile storage JSON file (same place as other durable data).
  Pursued history is a first-class view over that ledger (`outcome: pursued`),
  with the packet and Fleet session parsed from the retire reason; opening the
  board also retires bare stubs that duplicate a pursued title.
- The Dreamer session is a normal scheduled session in its own conversation,
  because the schedule's `new` target is the supported way to deliver an agent
  preset on a recurring rule.
- `ready_for_review` dreams are refreshed only when research changes something;
  the store does not block deeper edits, the persona does.
- Pursue uses a one-shot schedule delivery to start the Fleet session; the
  ended task is deleted right after delivery, including when the launch fails.
- The DSH launcher owns `dsh` top-level subcommands and a profile plugin cannot
  add one, so the literal `dsh dream brief` is not available. The supported
  surfaces are `/dream brief` in the app and the bundled `dream-brief` bin.
- The project directory comes from `projectCwd` or the workspace with the most
  sessions; packets are written under that directory's `briefs/`, not into the
  plugin package.
- The packet prompt is capped at 30,000 characters; a longer packet is
  truncated in the session preamble with a pointer to the full file on disk.
