# @local/session-tripwire

A workspace-scoped write-intent ledger for DeepSeek Harness. Every Session
pointed at the same workspace shares one ledger. Before a write tool runs, the
plugin checks whether another live writer holds the target; after it runs, the
plugin records the new content hash. The second writer learns which Session
holds the file, what changed, and what to do next.

## What it does

- **Session registration.** `session/created` registers the Session id, cwd,
  pid, and start time in `.dsh/tripwire/state.json`. `session/disposed` marks the
  writer offline; its leases still expire by TTL, so a crash cannot hold a file
  forever.
- **Hash-recorded writes.** `tools/post-execute` stores a SHA-256 of the file
  after each write, the hash from before the write, the fence, and the tool
  name. A later Session can see that the file changed since it last read it.
- **Observe, warn, and block.** `observe` records the overlap, allows the write,
  and leaves the current holder's lease intact (log-only). `warn` allows the
  write, takes the lease, and appends a notice containing the other Session id
  to the tool result. `block` refuses before dispatch with a typed
  `TRIPWIRE_CONFLICT` and three remediation choices: re-read, take ownership
  with `/tripwire claim <path>`, or stand down.
- **Leases with TTL and fences.** The first write takes ownership of a path and
  receives a monotonically increasing fence token. Every write extends the
  lease. A claim transfers ownership with a new fence; a writer that lost its
  lease and tries to record a late write gets a stale-owner conflict instead of
  silently taking the file back.
- **Board panel.** `GET /tripwire/board` renders who holds what, the recent
  hashes, the conflict feed, the ignore list, the mode selector, and the global
  kill switch. `GET /tripwire/state` is the same snapshot as JSON;
  `POST /tripwire/action` applies mode, kill, ignore, claim, and release
  actions.
- **Ignore list and kill switch.** Generated paths (`**/node_modules/**`,
  `**/dist/**`, lockfiles) are ignored by default. The kill switch makes every
  write bypass the ledger; it is the escape hatch if the guard itself is wrong.

## Files

| File | Responsibility |
|---|---|
| `ledger.js` | Workspace ledger: writers, write intents, content hashes, modes, leases, TTL, fences, ignore list, kill switch, journal replay. |
| `index.js` | Host plugin: Session lifecycle hooks, `tools/pre-execute`, `tools/post-execute`, `/tripwire` command, board/state/action/health routes. |
| `board.js` | Server-rendered board page. |
| `cordis.patch.yml` | Bundle insertion for a DSH profile. |
| `test/ledger.test.mjs` | Ledger behavior for every MVP bullet. |
| `test/plugin.test.mjs` | Host wiring over a fake Cordis context, including the real tool-hook signatures. |
| `demo/render-board.mjs` | Deterministic seeded board for review. |
| `docs/board.html` | Generated board preview (visible values for MVP-6). |

The ledger lives at `<workspace>/.dsh/tripwire/`:

- `state.json` — atomically replaced snapshot and the source of truth.
- `journal.jsonl` — append-only audit trail, and a replay fallback if the
  snapshot is missing or unreadable.

## Run and verify

```sh
cd session-tripwire
npm test                 # 24 tests in one process; safe in confined shells
node --test              # the same suites through the Node test runner
node demo/render-board.mjs   # regenerate docs/board.html
node --check index.js && node --check ledger.js && node --check board.js
```

`npm test` is the primary command. `node --test` spawns one child per test file;
some confined environments deny that spawn (`EPERM`), which is why the package
script uses `test/run.mjs` to import the suites in one process.

## Board

Once the bundle is loaded, open:

```
http://127.0.0.1:<web-port>/tripwire/board
```

`/tripwire board` prints the exact URL. For a static review without a running
Harness, open [docs/board.html](docs/board.html); it is rendered from a seeded
workspace with three writers and one blocked conflict. The static page shows the
same values, but its POST controls need the live `/tripwire/action` route. The
board shows the `warn` mode, the ignore list, three active leases, three recent
writes, and both the warned and blocked conflict decisions.

## Command

```
/tripwire status
/tripwire board
/tripwire claim <path>
/tripwire release <path>
/tripwire ignore <glob>
/tripwire unignore <glob>
/tripwire mode observe|warn|block
/tripwire kill | /tripwire revive
```

`claim` and `release` act as the invoking Session, so a claim fences out the
previous holder and transfers the lease to the current Session.

## Install in a desktop profile

The bundle is not installed by this build. To link it into a profile, add the
package to the profile's `package.json` and to its `dsh.profile.bundles` list,
then restart the Harness:

```json
{
  "dependencies": {
    "@local/session-tripwire": "link:<repo>/plugins/session-tripwire"
  },
  "dsh": {
    "profile": {
      "bundles": ["...existing bundles...", "@local/session-tripwire"]
    }
  }
}
```

The bundle's `dsh.bundle.patch` inserts the `session-tripwire` entry. Optional
plugin configuration:

```yaml
- id: session-tripwire
  config:
    workspaceRoot: C:/path/to/workspace   # defaults to the launch directory
    mode: observe                         # observe | warn | block
    ttlMs: 120000                         # 1s .. 24h
    ignore: ["**/node_modules/**", "**/dist/**"]
```

The default mode is `observe` on purpose: run it for a while, read the board's
conflict feed, then move to `warn` and only later to `block`.

## Acceptance mapping

| Check | Demonstrates |
|---|---|
| MVP-1 | `session/created` registration of two Sessions in one ledger; reopen and journal replay; board/state routes expose both writers. |
| MVP-2 | `write` through the real pre/post pair stores the 64-hex before/after hashes, `changed: true`, and a `write` journal entry. |
| MVP-3 | `warn` mode appends `Tripwire warning …` containing the other Session id to the allowed tool result; `observe` records without a notice. |
| MVP-4 | `block` mode returns `kind: deny`, `info.code: TRIPWIRE_CONFLICT`, and a reason naming re-read, claim, and stand-down; the file is unchanged. |
| MVP-5 | A lease is held before its 1s TTL, free after it; the next writer gets a higher fence; a stale writer is rejected; a claim transfers ownership at a new fence; an offline writer's lease expires. |
| MVP-6 | The board renders holders, before/after hashes, the ignore list, mode selector, and kill switch; POST actions toggle the kill switch and edit the ignore list. |

## Known limitations and follow-ups

- **Shell writes are not intercepted.** `bash`, `pwsh`, redirects, and arbitrary
  programs can write files without passing `tools/pre-execute`. The guard covers
  `write`, `edit`, `apply_patch`, and `str_replace_editor`. A shell-command
  parser or a filesystem watcher is the follow-up.
- **Block mode refuses; it does not merge.** The architecture's three-way merge
  (pre-write snapshot, current file, pending write) is deliberately out of this
  MVP. A clean-merge handoff and quoted-conflict result are follow-ups.
- **The board is a served page, not a docked client panel.** It is a real screen
  at `/tripwire/board`, reachable from the composer and `/tripwire board`, but it
  does not add a widget to the conversation dock. A Client module is a follow-up.
- **Cross-process serialization is snapshot-atomic, not lock-serialized.**
  `state.json` is written to a temporary file and renamed, so readers never see a
  torn snapshot. Two Harness host processes mutating the same ledger
  simultaneously can still lose one update. In-process Sessions and subagents
  share the plugin instance and serialize through the ledger's write queue.
- **Path identity is lexical after `realpath`.** Symlinks are resolved for the
  file or its nearest existing parent; Windows keys are case-folded. Hard links
  and junction-to-junction equivalence are not modeled.
- **The ledger itself is git-ignored by convention.** `.dsh/**` is in the default
  ignore list and the plugin never leases `.dsh/tripwire/*`; no `.gitignore`
  entry is added automatically.
- **No heartbeat loop.** Liveness is refreshed on registration, writes, and
  claims; a Session that goes idle still expires its leases by TTL. A periodic
  heartbeat is a follow-up.
