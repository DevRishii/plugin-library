# @local/idea-board

A resizable, dockable idea board widget for the Harness Web UI with three tabs:

- **Ideas** — a compact todo list for ideas that stays saved.
- **Dreams** — AI-generated product dreams, researched and scored by the
  `/dreamer` loop from your ideas, session history, and deterministic
  session-activity receipts (files changed, failures, open threads, cost);
  review one and **Pursue** it into a Fleet buildout (which first renders a
  build packet) or **Discard** it.
- **Nightmares** — a backlog of real defects raised by the `dsh-doctor`
  workspace checker. Each entry carries the failing check, the evidence paths,
  and the suggested fix. **Run doctor now** rescans from the window, **Squash**
  starts a Fleet repair session in one click, and **Keep** is the only path that
  asks for a reason. Nothing is repaired silently.

See [DREAM-BOARD.md](DREAM-BOARD.md) for the Dream Board schemas, the Dreamer
agent, the loop, and how to change the schedule, cap, and rubric.

## Use

- **Widget:** a floating card anchored at the bottom-right corner
  (`shell.overlay`). Drag it by its header; resize it from any edge or corner;
  collapse it to a small pill with the chevron. The **dock** button pins it into
  the sidebar footer, above Settings and the signed-in account row; the docked
  height is resizable from its top edge, and **pop out** returns it to a
  floating window. When the sidebar is collapsed to the rail, the docked board
  becomes a bulb button beside Settings. Position, size, docked state, and tab
  are saved with the list. Sizes are clamped to the viewport and the Host
  bounds.
- **Ideas tab:** type in the composer and press Enter or the plus button.
  The circle toggles done; click an idea's text to edit; the × deletes it;
  **Clear done** removes finished rows.
- **Dreams tab:** dreams are grouped into new features, new apps, and new
  services. Each row carries status, category, score, iteration count, source
  count, last-refined date, MVP and competitor counts, and research state. Click
  one for the full spec. The header's expand button switches to a bigger
  master-detail window with the grouped list on the left and the full spec on
  the right. The toolbar pauses/resumes the dreamer or runs it now. **Pursue**
  confirms, writes the build packet, then launches a Fleet session seeded with
  it; **Discard** takes an optional one-line reason.
- **Feedback:** the footer shows counts plus a saving or failure indicator. A
  load failure shows an inline retry banner.
- **Nightmares tab:** undecided entries (open, accepted) are grouped above the
  decided ones, most severe first. Click one for its evidence, the typed fix,
  the decision comment, and the transition history. The tab loads only when you
  open it, and the header's expand button gives it the same master-detail split
  as the Dreams tab. Its toolbar's **Run doctor now** button runs
  `dsh-doctor --nightmares` in the workspace and folds the feed into the
  backlog, then reports the added/updated/cleared counts — the Nightmares
  counterpart of the Dreams tab's run-now control.

## Nightmare backlog

`dsh-doctor` in the workspace finds defects; the Nightmares tab is where they
wait for a decision. The tab's **Run doctor now** button performs the same scan
from the window. Feed it from any session with the `nightmare_add` tool by
passing the output of `node dsh-doctor/bin/dsh-doctor.mjs --nightmares`:

```sh
node dsh-doctor/bin/dsh-doctor.mjs --nightmares
# -> { "source": "dsh-doctor", "generatedAt": "...", "findings": [...], "passing": [...] }
```

The run button resolves the checker at `dsh-doctor/bin/dsh-doctor.mjs` beside
this bundle and scans `projectCwd` (or the bundle's workspace). Set the
`doctorScript` and `doctorCwd` config fields when the checker or the scanned
project lives elsewhere; a missing script reports the path it looked for.

- `findings` holds only the defects; `passing` names the checks that ran and
  passed. Both matter: a passing check closes its open entry automatically, so
  fixing a defect takes it off the backlog without a manual step.
- Entries are deduplicated by check id plus evidence paths, so the same defect
  seen twice refreshes one row (rising `occurrences`) instead of creating two.
- A defect that comes back after being auto-closed reopens.
- A decision you made by hand is never overridden by a later scan: an ignored
  or removed entry stays decided and only records the new sighting.

**Squash** is the one-click action, the counterpart of **Pursue** on a dream.
It launches a Fleet session seeded with the finding, its evidence, the suggested
repair, and the acceptance check that must pass — and with an explicit
instruction not to weaken the check. The entry moves to `accepted` and shows the
session id. It becomes `fixed` only when a later doctor run reports that check
passing, so a launch is never mistaken for a repair.

**Keep** opens the reason box: you only write a comment when you are keeping a
finding. Confirming either **Keep it** (ignored) or **Remove** (removed) stores
the reason, and the store refuses both without one. A decided entry offers
**Reopen**, which needs no reason.

## Build packets

A build packet is the fleet-ready brief for one dream: objective, target user,
non-goals, MVP scope, one acceptance test per MVP bullet, a repository file map,
verification commands, a human review checklist, and the dream's research
context. It renders deterministically from the dream, an editable template, and
a bounded scan of the project directory — no model call and no network access.

- `/dream brief <id>` writes `briefs/<slug>.md` and
  `briefs/<slug>.checks.json`, then reports both paths. The dream stays on the
  board.
- `/dream brief <id> --attach` writes the packet and starts a Fleet session
  seeded with it; the dream moves to discard memory as pursued, exactly like
  the board's **Pursue** button.
- `/dream list` lists the active dream ids.
- `--out <dir>` changes the output directory; it must stay inside the project
  directory.
- `briefs/template.md` is seeded on first use and belongs to you: edit any
  documented slot without touching code. Unknown slots stay visible and are
  reported, so a typo does not silently vanish.
- `briefs/<slug>.checks.json` holds one `pending` / `pass` / `fail` check per
  MVP bullet, each with an `expected` result, a review hint, and an evidence
  note. Regenerating keeps a check's status and evidence while its MVP bullet is
  unchanged, and resets it when the bullet changes.

The packet scans the project directory selected by `projectCwd` (or the
workspace with the most sessions): top-level directories, manifests, package
scripts, existing test files, the README, and git state. The scan is an
orientation map, not a file-by-file index; the packet says so and names the
projects whose package names share words with the dream.

From a terminal, without the app:

```sh
node idea-board/bin/dream-brief.mjs <dream-id> --cwd <project> [--out briefs]
node idea-board/bin/dream-brief.mjs --list
```

The CLI reads the Dream Board storage JSON directly (default
`%USERPROFILE%\.dsh\storages\dream_board.json`, override with `--storage`), so
it never writes the board; it writes only the packet files. `--attach` is
available only in the app, where the schedule service exists.

The literal `dsh dream brief` subcommand is not available: the DSH launcher owns
its top-level commands and a profile plugin cannot add one. `/dream brief` is
the in-app surface; the bundled `dream-brief` bin is the terminal equivalent.


## Storage

The Host half owns four documents through the composition's storage service
(the `json` backend when mounted, otherwise the first mounted backend):

- `idea_board.json` — the Ideas tab (one key-value unit named `idea_board`).
- `dream_board.json`, `dream_discards.json`, `dream_runs.json` — the Dream
  Board, discard memory, and run log (units `dream_board`, `dream_discards`,
  `dream_runs`).
- `nightmare_board.json` — the Nightmares backlog (unit `nightmare_board`).

The browser reads and writes through same-origin routes; no data lives in
browser storage, so it survives a port change, restart, or a different browser
window. Idea writes are serialized by the Host and carry a revision; a page
that saved against an older revision receives `409` with the newer document.

## Files

- `index.js` — Host half: idea storage and routes, Dream Board wiring, Dreamer
  tools, the `/dreamer` and `/dream` commands, the brief route, managed
  schedule, per-run caps and failure log.
- `dreams.js` — Dream Board domain: schemas, dedup, readiness, lock, packet
  pursuit, Fleet launch.
- `nightmares.js` — Nightmare backlog domain: finding normalization,
  fingerprint dedup, the approval state machine, and auto-close on a passing
  check.
- `activity.js` — deterministic recent-session activity digest for the Dreamer,
  built from Session Diff receipts (files, failures, open threads, cost) with a
  recurrence rollup.
- `brief.js` — Build-packet domain: template rendering, bounded repository scan,
  acceptance checks, output containment. No model, network, or Dream Board
  store dependency.
- `bin/dream-brief.mjs` — headless packet CLI over the Dream Board storage JSON.
- `test/` — `node:test` unit and fake-context integration tests.
- `client.js` — Client half: the overlay widget, both tabs, copy, and styles.
- `cordis.patch.yml` — inserts the `idea-board` row and the `dreamer` preset.
- `locale/en.json`, `locale/zh.json` — Plugin Manager display metadata.
- `icon.svg` — original artwork.

Run the plugin tests from this directory:

```sh
npm test
# node --test --test-isolation=none test/*.test.mjs
```

## Limits

- At most 500 ideas, 500 characters each; the request body is capped at 512 KiB.
- At most 400 nightmares; once the board overflows, the oldest decided entries
  are dropped first, so undecided defects are never evicted.
- At most 10 active dreams by default, 12 web calls and 3 subagents per run.
- The card shares the overlay layer with host notices and is hidden while the
  fullscreen right panel is open.
- The scan is bounded: top-level directories, manifests one level down, files
  three levels deep, at most 120 files counted per top-level directory, and 12
  sample test paths. It is an orientation map, not a full index.
- Packets and the template must stay inside the project directory; slugs are
  bounded ASCII, and a title collision with a different dream gets an id suffix
  instead of overwriting the first packet.
- Only one buildout launch per dream can be in flight; a double click gets a
  `busy` error from the second request.

