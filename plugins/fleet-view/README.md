# @local/fleet-view

A right-sidebar tab that shows the current session and its whole subagent
tree as a live node tree, with per-node cost and an estimated swarm total.

Client-only v1: `index.js` is `export function apply() {}`; every surface is
registered from `client.js`. No Host projection, service, or config row is
added by this bundle.

## Use

- **Opener:** a compact **Fleet** button in the conversation header actions
  band (`conversation.session.header.actions`) opens the tab for the current
  session through `ctx.sidebarRight.openTab('fleet')`. Nothing opens on mount,
  so the saved per-session sidebar layout is never claimed automatically; the
  right Sidebar's own layout persistence restores the tab when it was open in
  a previous window.
- **Root:** the viewed session. Children are its `subagentCatalog` entries,
  then recursively each child's own `subagentCatalog`. Local, one-shot,
  continuable, unknown-mode and external entries are shown; external entries
  are leaves with no child catalog and no navigation. Unknown-mode rows stay
  visible and fall back to the child id as their label.
- **Rows:** indentation, status dot (unified UI running status, falling back
  to the Session summary's running state), title/label, mode, a compact
  model/thinking chip, whole-log token total from `tokenUsage`, active-turn
  duration from `subagentTiming`, and the node's estimated cost.
- **Model/thinking chip:** each row that has a recorded model selection shows
  `Flash · think max` (or `Pro · …`), read from that Session's `modelSelection`
  projection. The model label is `Flash` or `Pro` for the published DeepSeek
  routes and the raw model id otherwise; the thinking part is the
  adapter-owned `reasoningEffort` id recorded with the selection (for example
  `max`), or `default` when the recorded selection carries no explicit effort
  (the adapter default applies). The full model id and effort are in the chip's
  tooltip. The chip is absent while the selection projection is not loaded, and
  external leaves have none because they have no local Session to read.
- **Header:** estimated swarm total = the sum of every discovered node's cost
  (the viewed session plus all descendants); it updates live from projection
  frames. While cold reads are in flight the total is marked `loading`; if a
  branch could not be read it is marked `partial` instead of presenting a
  wrong number.
- **Empty/loading/error:** the viewed session always renders. An empty root
  catalog shows "No subagents yet"; a failed projection read shows a per-branch
  message with a Retry button.

## Loading model

Cold descendant projection reads are warmed level by level: the tree is
discovered from catalogs already loaded, at most 3 reads run at a time, and
each Session id is requested once and cached (failed reads can be retried
explicitly). A failed branch never blocks the rest of the tree. A hard bound of
200 nodes per walk keeps a pathological lineage from freezing the panel.

## Cost estimate (v1 approximation)

- Pricing reuses the published DeepSeek rate table from **@local/turn-cost**
  (the two tables are intentionally identical; keep them in sync). The table
  and money formatter are copied into `client.js` because a Client plugin
  cannot `require()` another Harness Client package.
- The model id comes from each Session's recorded `modelSelection` projection.
  When it is unavailable or names an unpublished model, the node is priced at
  `deepseek-flash` rates; the header note covers the approximation.
- `tokenUsage` aggregates the whole log and carries no per-attempt timestamp,
  so peak/off-peak cannot be applied per attempt. This version applies one
  consistent factor to every node, taken from the viewed session's last
  recorded activity (`updatedAt`; wall clock when unavailable). Chinese public
  holidays are not modeled.
- The swarm total and every node reading are estimates, not a bill.

## Install

Installed in the `desktop` profile with `plugin_manager` `install_bundle`. A
Client-file change requires a page refresh when hot reload is unavailable.
