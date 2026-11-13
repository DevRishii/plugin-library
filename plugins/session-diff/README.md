# Session Diff

A deterministic per-session receipt for DeepSeek Harness. When you come back
after an unattended or scheduled session you get one artifact that answers:

- which files changed, with **before/after SHA-256** (added, modified, deleted);
- which shell commands ran, with **exit code and the first failing line**;
- which **models** served the session and what each turn **cost**;
- which plugins and settings were touched;
- which **threads are still open** — the last failing command, failed test runs,
  TODO items, TODO markers written into files, and turns that did not complete.

Every line comes from a durable session event, a snapshot the plugin captured
before a write, or a file hash. No model writes the receipt, so it cannot invent
work that did not happen.

## What is in the box

| Piece | Path | Purpose |
| --- | --- | --- |
| Host plugin | `index.js` | Captures pre-write snapshots, records a receipt at every `turn/end`, serves the routes, the `receipt` tool, and `/receipt`. |
| Client panel | `client.js` | Right-sidebar **Receipt** tab with export buttons (Markdown, JSON, HTML). |
| Receipt engine | `src/receipt.mjs` | Joins session facts, workspace hashes, and snapshots. |
| Session reader | `src/session.mjs` | Reads the multi-frame `session.v4.jsonl.zstd` log. |
| Snapshots | `src/snapshots.mjs` | Content-addressed pre-write store, retention, restore. |
| Renderers | `src/render.mjs` | Markdown, standalone HTML, stable JSON. |
| Compare | `src/diff.mjs` | Receipt-to-receipt comparison. |
| CLI | `bin/dsh-receipt.mjs` | `print`, `compare`, `export`, `list`, `restore`, `gc`. |

## Install into a profile

Add the package as a link dependency and a bundle, then restart the app:

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "@local/session-diff": "link:<repo>/plugins/session-diff"
  },
  "dsh": { "profile": { "bundles": [/* ..., */ "@local/session-diff"] } }
}
```

The bundle patch (`cordis.patch.yml`) inserts one row; no other profile edit is
needed. Snapshots default to on with a 7-day / 500 MB retention and a 2 MB
per-file capture cap. Optional config (validated by `effectiveConfig`; no schema
export):

```yaml
- id: session-diff
  config:
    snapshots: true
    retentionDays: 7
    maxBytes: 524288000
    maxFileBytes: 2097152
    recordOnTurnEnd: true
```

This build does not modify the live profile.

## CLI

Run from the workspace you want receipts for, or pass `--cwd`:

```sh
# Print the receipt recorded for the latest session (or a session id / log path)
node session-diff/bin/dsh-receipt.mjs print latest

# Re-derive from the session log + current workspace instead of the stored record
node session-diff/bin/dsh-receipt.mjs print session-456d1e41-9f37-4d4b-8b4e-1e6deedb1098 --rebuild

# Machine-readable
node session-diff/bin/dsh-receipt.mjs print latest --json

# Compare two receipts
node session-diff/bin/dsh-receipt.mjs compare <session-a> <session-b> --json

# Export
node session-diff/bin/dsh-receipt.mjs export latest --format markdown --out receipt.md
node session-diff/bin/dsh-receipt.mjs export latest --format json     --out receipt.json
node session-diff/bin/dsh-receipt.mjs export latest --format html     --out receipt.html

# List sessions and whether they have a recorded receipt
node session-diff/bin/dsh-receipt.mjs list

# Restore one file from its pre-write snapshot (refuses when the file drifted)
node session-diff/bin/dsh-receipt.mjs restore <session> path/to/file.txt
node session-diff/bin/dsh-receipt.mjs restore <session> path/to/file.txt --force

# Retention collection
node session-diff/bin/dsh-receipt.mjs gc --days 7 --max-mb 500
```

Options: `--cwd <dir>`, `--home <dir>`, `--json`, `--rebuild`, `--format`,
`--out`, `--force`, `--include-all`, `--days`, `--max-mb`.

The package also declares `dsh-receipt` as its `bin`; `dsh` launcher
subcommands are not plugin-extensible in DSH `0.2.2-rc.1`, so `dsh-receipt …`
is the command surface the packet calls `dsh receipt`.

In the GUI the same surface is the **Receipt** tab in the right sidebar (opened
from the session header), the `/receipt` slash command, and a `receipt` tool an
agent can call with `action: print | compare | export | restore`.

## Data layout

```
~/.dsh/receipts/<workspace-slug>/<session-id>/
  receipt.json          recorded at every turn end
  receipt.md            rendered copy
  snapshots/index.json  path → captures
  snapshots/objects/ab/abcdef…   content-addressed pre-write bytes
```

The receipt store sits beside `~/.dsh/sessions`, so receipts are global to the
Harness install rather than to one workspace, and do not pollute the project.

## How before/after hashes are earned

| `beforeSource` | Meaning |
| --- | --- |
| `snapshot` | The plugin captured the file immediately before the first write. Authoritative. |
| `derived` | No snapshot, and every mutation was an `edit`: the edits were reversed from the current file and the forward replay was verified. Deterministic; an external formatter between edits can make it the wrong pre-image. |
| `absent` | The session created the file; there is no before state. |
| `unavailable` | The first mutation was a whole-file `write` with no snapshot. The receipt does not guess. |

`afterSha256` is the current on-disk hash. `status: deleted` means the path was
absent when the receipt was generated — a delete during the session, or a file
removed afterwards.

## Open threads

Deterministic rules, no model:

- the most recent command whose last run exited non-zero (a later success for
  the same command resolves it);
- every failed test run (`vitest`, `jest`, `pytest`, `node --test`, `npm/pnpm
  test`, … and their failure output pattern);
- pending items of the last `todo/write`;
- `TODO` / `FIXME` / `XXX` markers written by `write` or `edit` this session;
- turns that ended with a reason other than `completed`.

## Verification

From `session-diff`:

```sh
npm test          # node --test --test-isolation=none
```

`--test-isolation=none` is required in confined environments where the Node test
runner cannot spawn per-file child processes.

`npm run build` regenerates the `en` / `zh` dictionaries `client.js` embeds from
`locale/*.json`, the source of truth for that copy. Run it after a locale edit so
the bundle never lags its sources — `dsh-doctor`'s `plugin.client-bundle-stale`
check enforces exactly that ordering. `node scripts/build-client.mjs --check`
verifies without writing.

The suites cover: multi-frame zstd reading and session discovery; fact
extraction (commands, exit codes, usage, switches, TODOs, plugins); receipt
assembly with snapshots, derivation, deletion, exclusion, cost, and threads;
snapshot retention and drift-safe restore; renderers and compare; the host
plugin's capture → record → serve → restore path against a fake Cordis host;
the client module's tab/opener registration and locale key parity; and the CLI
commands end to end.

## Dreamer integration

The Idea Board plugin consumes this engine: `idea-board/activity.js` summarizes
the recent sessions' receipts into a bounded `activity` block on `dream_context`
(files, failures, open threads, models, cost) plus a recurrence rollup of files,
failures, and open threads. It reads stored receipts first and builds one from
the session log when none exists; the Dreamer is instructed to ground new
dreams in that observed friction and cite the source session ids. See
`idea-board/DREAM-BOARD.md`.

## Known limitations and deferred work

- Files changed only by a shell command (not by `write`/`edit`) are not in the
  file list; the receipt records file-tool mutations, not a full git-style diff.
- `derived` before-hashes are a best-effort reconstruction; use snapshots for an
  authoritative pre-image.
- Subagent sessions get their own receipts; a parent receipt does not merge a
  child's files or cost.
- Each turn end rebuilds the whole session receipt (facts plus file hashes),
  debounced 300 ms; a very long session with many turns pays that rebuild each
  time. Incremental accumulation is deferred.
- Live GUI rendering of the panel was verified at module and route level, not in
  a browser.
