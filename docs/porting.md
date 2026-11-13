# Porting to other desktop agent apps

The goal of this repository is not "DSH plugins forever". It is to keep the
**reusable core** of each feature in plain Node and plain data, so another
desktop agent host — OpenCode, a Claude/Codex-style shell, an Electron app with
its own tool registry — can run the same idea behind a thin adapter.

## 1. The host contract

Six ports cover almost everything in this library. A host implements the ports;
a plugin consumes them. DSH is just the first implementation.

```ts
// Host services a portable plugin may need. Every method is optional per plugin.
interface HostPorts {
  // Where the session came from: durable events, not model prose.
  sessions: {
    current(): SessionRef
    events(session: SessionRef): AsyncIterable<SessionEvent>  // tool calls, turns, messages, todos
    transcript(session: SessionRef): AsyncIterable<Event>      // raw store, if the host keeps one
  }

  // Token and model accounting for cost surfaces.
  usage: {
    tokens(session: SessionRef): TokenBuckets                  // uncached/cacheRead/cacheWrite/output
    route(session: SessionRef): { provider: string; model: string }
  }

  // Durable storage owned by the plugin, not the host.
  store: {
    read(unit: string): Promise<unknown>
    write(unit: string, value: unknown): Promise<void>
  }

  // Tool and command registration.
  tools: { register(tool: ToolSpec): Disposable }
  commands: { register(command: CommandSpec): Disposable }

  // Surface registration: a slot, panel, status item, or window.
  ui: {
    register(slot: SlotId, component: Component): Disposable
    theme: { overrideTokens(tokens: Record<string, string>): Disposable }
    locale: { t(key: string): string }
  }

  // Agent orchestration and long-running work.
  agents: { launch(spec: AgentSpec): Promise<SessionRef> }      // Pursue / Squash
  schedule: { upsert(job: JobSpec): Promise<JobId> }            // Dreamer

  // Filesystem intent, for write-conflict safety and pre-write snapshots.
  fs: {
    onWriteIntent(handler: (path: string, session: SessionRef) => IntentResult): Disposable
    processPath(path: string): string
  }

  // Process-level actions, for the restart button.
  shell: {
    isOwned(pid: number): boolean
    relaunch(): Promise<void>
  }
}
```

Two rules make porting cheap:

1. **Keep the math and the model host-free.** Pricing tables, receipt
   derivation, dream scoring, snapshot addressing, and check evaluation are
   pure functions over plain objects. They must not import a host SDK.
2. **Keep exactly one binding file per host.** `cordis.patch.yml` +
   `client.js` are the DSH binding. A second host gets a second binding, not a
   fork of the core.

## 2. Portability matrix

Score: 1 = deeply bound to the DSH client, 5 = runs unchanged on any Node host.

| Package | Score | Portable core | What the host must supply | Rough effort |
| --- | ---: | --- | --- | --- |
| `dsh-doctor` | 4 | all checks, fix planning, history, CLI | a workspace path and a version string | low — already CLI-first |
| `packs/hivemind` | 4 | agent/command Markdown, stack profiles, switch CLI | a host that reads Markdown agents/skills | low — OpenCode-native today |
| `session-diff` | 3 | receipt facts, snapshots, renderers, CLI | session events, pre-write hook, panel/route | medium |
| `session-tripwire` | 3 | ledger, leases, conflict decisions, board HTML | tool pre/post hooks, HTTP route, session ids | medium |
| `turn-cost` | 2 | rate table, bucket pricer, normalization | usage projection, model route, stat slot | medium |
| `fleet-view` | 2 | tree walk, totals, money/token formatting | subagent tree + timing + usage provider | medium–high |
| `theme-engine` | 2 | palette catalog and token roles | theme token override + settings row | medium |
| `restart-app` | 2 | single-flight relaunch state machine | owned-PID check, close/launch adapter | medium |
| `idea-board` | 2 | dream/nightmare stores, brief generator, activities | storage, routes, slots, schedule, agent launch | high |
| `fleet-preset` | 2 | persona + orchestration playbook + budget/route tables | preset registry, delegated subagents, skills | medium (content) |

### Notes per package

**dsh-doctor** is the easiest win: it is a dependency-free Node CLI whose only
DSH assumptions are the workspace layout (`dsh-src`, profiles) and a harness
version for range-gated checks. Another app can call it unchanged or map its
own paths.

**hivemind** is already cross-app: OpenCode agents, commands, skills, and five
provider stack profiles, installed by `install.sh` / `install.ps1`. Any host
that discovers Markdown agent directories can adopt the content as-is.

**session-diff** has the cleanest split: `src/facts.mjs`, `src/receipt.mjs`,
`src/render.mjs`, `src/snapshots.mjs` are plain Node. Only the event extractor
(`src/session.mjs`) and the DSH hook names bind it. The snapshot store is a
content-addressed `node:fs` store that any host can reuse.

**session-tripwire** is a workspace-scoped ledger with leases, fences, TTLs,
and a kill switch. The decision logic and journal are host-neutral; the binding
is `tools/pre-execute` / `tools/post-execute` plus the board route.

**turn-cost** and **fleet-view** duplicate a rate table. Before porting either,
extract one `rates` module. After that, each host only needs to supply token
buckets and the serving route.

**theme-engine** maps eight palettes onto fourteen DSH token names. Keep the
catalog keyed by semantic role and map `--dsw-alias-*` in the DSH adapter; the
palette data then works in any webview.

**restart-app** is useful in any Electron app, but today it hardcodes the
`deepseek harness.exe` image and `taskkill`. Extract `{isOwned, closeSelf,
launch}` and it becomes host-agnostic.

**idea-board** is the biggest, but the value is architectural: durable board
documents behind host routes; an agent whose only write tools are typed board
operations; a run lock plus per-run caps; deterministic activity receipts;
build packets with acceptance checks; and the review → pursue/squash →
auto-close state machine. Port the stores and schemas first, the UI second.

**fleet-preset** ships the Fleet operating loop as content: persona prompt,
five-step brief → fan-out → verify → synthesize loop, tier table, budget tiers,
and the anti-waste checklist. The text transfers; the plugin rows are DSH
wiring.

## 3. Known machine-local bits

These are the only places in the tree that still assume this machine. Fix them
when cloning elsewhere:

1. `plugins/fleet-preset/cordis.patch.yml` → `customSkillDirs` must point at
   the installed `fleet-preset/skills` directory. The live profile currently
   uses an absolute workspace path; the repository copy is the thing to keep
   correct if you re-link the profile.
2. `plugins/session-diff/README.md` shows an example `link:` path containing a
   personal directory. It is illustrative only; `npm run link` generates the
   real path.
3. `dsh-doctor` expects a Harness install to detect its version. Pass
   `--harness-version` when running outside DSH.

`npm run verify` fails on any absolute `C:\Users\<name>\` path in the tree, so a
new machine-local path cannot slip in silently.

## 4. Porting recipe

1. **Extract** the pure module from the plugin (no host imports; unit tests
   move with it).
2. **Define** the smallest port it needs from the list above — one or two
   methods, not the whole interface.
3. **Bind** DSH in `index.js`/`client.js`, and put the new host's binding in its
   own package or directory (`hosts/<app>/...`).
4. **Fake** the port in tests so the core stays testable without any app.
5. **Document** the capability the host must supply in the plugin README's
   portability section.

The tests in this repository already run without the DSH app; that is the
baseline a second host must preserve.
