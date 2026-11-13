# Sidebar vertical split

Design work for stacking the right sidebar's two panes vertically instead of
horizontally. Not an installable package.

| File | Purpose |
| --- | --- |
| `0001-feat-client-stack-the-right-Sidebar-s-two-panes-vert.patch` | Patch against the DSH client source; applies the vertical stack, drag handle, and persisted orientation |
| `NOTES.md` | Why the layout is worth changing, the patch's shape, and the tradeoffs |

Keep this directory together: the patch is 106 KB and its context is the
client source it was produced against. Rebase it before applying to a newer
checkout.

If this ships, it becomes a client package under `plugins/` whose `dsh.client`
declares the sidebar injection — see [`../docs/porting.md`](../docs/porting.md)
for the slot and theme seams.
