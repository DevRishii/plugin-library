# Restart app

A restart button for the DeepSeek Harness desktop app, plus the `/restart-app`
command the button dispatches. It exists so Creator-mode plugin work does not
need a trip to the tray: after a profile change reports that a restart is
required, one click closes the app and opens it again.

## Where it appears

- A circular-arrow button at the left of the composer tool row, in every
  conversation. It opens a small confirmation panel with **Cancel** and
  **Restart**; Escape and a click elsewhere dismiss it.
- `/restart-app` in the composer command menu, for the same operation without
  the mouse.

## What a restart does

1. The button runs the Host command `/restart-app`; the Host answers first, so
   the conversation records the command and the panel can show "Restarting…".
2. About 1.5 s later a detached helper closes the Electron shell and the Host,
   then starts the app executable again. The helper outlives the app process,
   which is what lets it relaunch it.
3. The new app process loads the profile from scratch, so an installed package
   that replaced an older one now runs its new Host and Client code.

Sessions are durable: they reopen with their saved history. A turn that is
still streaming when the app closes is interrupted, which is what the
confirmation panel warns about.

## When it refuses

The command reports an error, without closing anything, when the Host is not a
child of the Desktop shell (for example `dsh web` started from a terminal), when
the app executable cannot be identified, or when the helper file is missing. A
second click while a restart is already scheduled is refused the same way.

## Diagnostics

Every restart writes a log to the system temp directory under
`dsh-restart-app/restart-<epoch-ms>.log`: the resolved process ids, when the
shell and Host disappeared, and each launch attempt. If the app does not come
back, that log names the step that failed.

## Scope

Windows desktop only. The helper uses `taskkill` to close the shell and Host and
starts the app from the path the shell itself runs.
