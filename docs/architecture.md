# Architecture

This repository is a **library of installable packages**, not a running
application. Every directory under `plugins/` is a self-contained ESM package
that the DeepSeek Harness (DSH) desktop app can load from a profile. The
`packs/` directory holds content for other desktop agent hosts, and
`experiments/` holds design work that has not been packaged.

Keeping the split explicit matters: the reusable ideas live in plain Node and
plain data, while the host binding lives in a thin, replaceable layer.

## 1. The two layers of a DSH plugin

A DSH plugin can contribute up to two halves:

| Layer | Runs in | Entry point | Declared by |
| --- | --- | --- | --- |
| Host | DSH's Node process | `exports["."]` (default `index.js`) | `dsh.bundle.patch` |
| Client | DSH's web renderer | `exports["./client"]` (default `client.js`) | `dsh.client` |

A host-only plugin (fleet-preset, dsh-doctor) has no client half. A plugin with
a client half still has a host half even when it does nothing (see
`theme-engine/index.js`, which only exists so the bundle can register).

### Bundle patch

`cordis.patch.yml` is the manifest the profile applies. The smallest possible
patch is one row:

```yaml
- insert:
    - id: turn-cost
      name: '@local/turn-cost'
```

The patch is applied **in bundle order** from the profile's
`dsh.profile.bundles` array, after which the profile's own `cordis.patch.yml`
is applied. Rows are addressed by `id`, so later layers can override config or
disable a row. `idea-board` uses the same mechanism to insert its `dreamer`
agent preset, with a persona, a restricted tool list, and a schedule.

### Client metadata

```json
"dsh": {
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": ["@deepseek-ai/dsh-client-ui-conversation", "..."]
  }
}
```

`inject` names the client services the module consumes (slots, sessions,
sidebar tabs, theme, locale). DSH loads the module after those services exist.
`immediately` means load at startup rather than on first use.

The client module registers UI through **slots** — named extension points such
as `conversation.composer.dock`, `sidebar.right.pane.tab`,
`conversation.session.header.actions`, `conversation.input.left`, and
`settings.general.item`. A plugin never patches another plugin's DOM; it
contributes a component to a slot and owns its own styles.

## 2. Package anatomy

```
plugins/<name>/
  package.json          name, version, exports, dsh metadata, test script
  cordis.patch.yml      host rows to insert (when dsh.bundle is declared)
  index.js              host module (Node, ESM)
  client.js             client module (browser ESM) — or a generated bundle
  src/                  authored client source when client.js is generated
  locale/               en.json / zh.json namespaces
  test/                 node:test suites
  bin/                  standalone CLIs
  README.md             usage, limits, verification notes
```

Two packages generate `client.js` from `src/client.js`
(`restart-app`, `session-diff`) and ship a `build-client.mjs` check. Keep the
generated artifact in sync; the `--check` mode fails on drift.

## 3. Where state lives

Nothing in this repository is state. At runtime, plugins persist to:

| Store | Owner | Contents |
| --- | --- | --- |
| Profile JSON storage (`~/.dsh/profiles/<profile>/storage` / storage domain) | idea-board | `idea_board`, `dream_board`, `dream_discards`, `dream_runs`, `nightmare_board` |
| `~/.dsh/receipts/<workspace>/<session>/` | session-diff | `receipt.json`, `receipt.md`, pre-write snapshot objects |
| `~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd` | DSH (read) | the event log receipts and activity are derived from |
| `<workspace>/.dsh/tripwire/` | session-tripwire | journal, leases, board state, ignore list |
| `<workspace>/.dsh/doctor/history.jsonl` | dsh-doctor | check history used by `--compare` and `--explain` |
| `<workspace>/briefs/` | idea-board | generated build packets, checks, template |
| `localStorage` (`dsh-theme-engine.preset`) | theme-engine | chosen palette id (client only) |

This is why `.gitignore` excludes `.dsh/`, logs, and backups: those are local
state, often containing session content. Do not commit them.

## 4. Runtime graph

```
profile package.json
  deps:  @local/*  -> link:<repo>/plugins/*
  bundles: [ ...local bundles... ]
        |
        v
cordis tree  --(patch per bundle)-->  host services (webServer, tools, commands,
        |                              storage, schedule, session events, fs hooks)
        |
        +--> client modules --> slots --> UI
```

Cross-plugin links that are intentional:

- **idea-board → dsh-doctor**: the Nightmares "Run doctor now" action runs the
  sibling `dsh-doctor/bin/dsh-doctor.mjs --nightmares` and folds the feed into
  the board.
- **idea-board → session-diff**: recent activity receipts use session-diff's
  recorded receipts when present.
- **idea-board → fleet**: "Pursue" and "Squash" launch a Fleet session seeded
  with a build packet or a defect repair brief.
- **fleet-view → turn-cost**: both carry a price table. They are copies; when
  prices change, update both (or extract one shared rate module — a natural
  first cross-package refactor).
- **fleet-preset → session-tripwire**: the Fleet playbook's tripwire check
  expects the session-tripwire board at `/tripwire/board`.

## 5. Loading, reloading, and verification

- Change a plugin, then restart the desktop app. `restart-app` exists for
  exactly that: a composer button and `/restart-app` command that relaunch the
  app so installed plugin changes load.
- `npm test` runs every plugin's suite; `npm run verify` checks package shape
  and repository hygiene; `npm run check` runs both.
- The library deliberately has **no build step for the library itself**. A
  plugin's own `build` script, if any, stays inside that package.
