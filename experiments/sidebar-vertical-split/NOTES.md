# Sidebar vertical split — upstream change

Branch: `feat/sidebar-vertical-split`
Commit: `a1054ff742092cd46149e0a34a311a24023fa112` (author `DevRishii <48538864+DevRishii@users.noreply.github.com>`)
Patch: `sidebar-vertical-split-patch/0001-feat-client-stack-the-right-Sidebar-s-two-panes-vert.patch`
Base: `deepseek-ai/deepseek-harness` master `fcc0ad4` (0.2.2-rc.1)

Fork branch: https://github.com/DevRishii/deepseek-harness/tree/feat/sidebar-vertical-split
Compare view: https://github.com/deepseek-ai/deepseek-harness/compare/master...DevRishii:feat/sidebar-vertical-split

## PR delivery status

A pull request **cannot be opened against `deepseek-ai/deepseek-harness`**: the
upstream repository has pull requests disabled (the pulls API returns 404, the
issue tracker is disabled, and `CONTRIBUTING.md` states that external pull
requests are not accepted at the moment). Discussions are enabled instead, so
the proposal was posted there:

- Discussion (Ideas): https://github.com/deepseek-ai/deepseek-harness/discussions/12935

The branch is pushed to the fork above and the compare link is the reviewable
diff.

## What it changes

The right Sidebar can now split its two panes **stacked (top/bottom)** as well as
side by side.

- `@deepseek-ai/dsh-client-ui-dockkit`
  - `DockLayout` renders a root split on either axis: row panes stay in Grid
    columns, column panes stack in Grid rows. The divider rotates and resizes on
    the matching axis; empty panes and floats are placed per axis.
  - `planSplitPane(..., axis?)` and `DockController.splitPane(paneId?, axis?)`
    accept `'column'`; the default stays `'row'`, so every existing caller is
    unchanged.
  - Docs (`README.md`/`README.zh.md`) updated.
- `@deepseek-ai/dsh-client-ui-sidebar-right`
  - `ctx.sidebarRight.split(paneId?, axis?)` supports `'column'` (new pane
    below), under the same two-pane budget and a per-axis room rule; the store
    action takes `{ axis?, settled? }`.
  - The seat reports both axes' room readings; `splitBlock` checks the asked-for
    axis.
  - New tab-context-menu action **Split pane vertically** runs the same intent
    on the column axis; it is absent when the pane budget, an empty pane, or the
    measured column room blocks it. The strip's split control still splits to
    the right.
  - Saved-layout validation now accepts a two-pane root split on either axis.
  - Fullscreen chrome/inset selectors cover stacked top/bottom panes.
  - Locale dictionaries (all 8 languages), README (en/zh) and translation-pair
    records updated.

## Verification run

Focused suites (Vitest + jsdom, React/testing-library installed ad hoc; not the
repo's full dependency tree):

```sh
node node_modules/vitest/vitest.mjs run --config <focus-config>
```

Result: **7 files / 193 tests passed**, including:
- dockkit `planner`, `controller`, `tab-layout` suites (adds column-axis planner,
  controller, and rendered-DOM tests);
- sidebar-right `stores`, `persistence`, `persistence-validation` (adds stacked
  layout restore), `service` (adds column split + per-axis room rule) suites.

Also run:
- `node --experimental-strip-types scripts/verify-translation-pairing.ts …` — both
  README pairs consistent (after `--write` re-record).
- Engine/sidebar hand checks against the real sources: column planner/apply,
  controller axis, store action, persistence round-trip, nested-split rejection,
  locale key parity across all 8 dictionaries.
- `git diff --check`; every changed file ends with one newline.

## Not run here (needs repo install)

- `pnpm install && pnpm run test:gui` (full GUI lane) and `pnpm run typecheck`
- `DSH_SNAPSHOT=replay pnpm run test:web` if the reviewer wants assembled-browser
  output coverage (the new visible action is product-user-visible copy, but the
  recorded-session fixtures do not open the sidebar menu).
- Build/smoke through `pnpm run build` — this checkout has no installed
  dependency tree, so the change is delivered as a source patch, not a built
  Desktop profile.

## UX note / possible follow-up

Vertical split is exposed from a tab's context menu, matching how this product
already places layout/close actions; the strip's split button stays horizontal.
A follow-up could make the split control choose an axis (or add a second chrome
button) once design signs off on the denser chrome.
