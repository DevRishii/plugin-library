# Install and development

## Prerequisites

- Node.js 22 or newer (the app ships its own runtime; the tests need Node).
- A DeepSeek Harness desktop profile (default profile name: `desktop`).
- `npm` on `PATH` for the per-plugin test scripts.

## 1. Clone

```powershell
gh repo clone DevRishii/plugin-library
cd plugin-library
npm run verify
npm test
```

The repository is private; `gh` must be authenticated as an account with read
access.

## 2. Wire a profile

DSH loads a plugin when either is true in
`~/.dsh/profiles/<profile>/package.json`:

- the package is a dependency: `"@local/<name>": "link:<abs path>"`, and
- the package is listed in `dsh.profile.bundles`.

The library ships a script that does both for every plugin, and replaces the
`node_modules/@local/*` junctions to match:

```powershell
npm run link:dry     # show what would change
npm run link         # apply; backs up the profile's package.json first
```

Pass `--profile <name-or-path>` for a non-default profile:

```powershell
node scripts/link-profile.mjs --profile work
```

Then restart the app. `restart-app` adds a restart button to the composer and
a `/restart-app` command; either reloads installed plugin code.

### What the script changes

1. `dependencies["@local/<name>"]` for each package in `plugins/`, as an
   absolute `link:` path with forward slashes.
2. `dsh.profile.bundles`: existing entries keep their order; library bundles
   that no longer exist are removed; missing bundles are appended in dependency
   order (theme-engine, turn-cost, fleet-preset, fleet-view, idea-board,
   session-tripwire, session-diff, restart-app). Unrelated `@local/*` bundles
   are left alone.
3. `node_modules/@local/<name>` junctions, so the running app resolves the new
   path even before the next package install.
4. A timestamped backup under `.plugin-library-backup/` inside the profile.

The script never deletes real (non-junction) directories and refuses to touch
anything it does not own. It does not run `pnpm install`; the lockfile is
refreshed on your next install, and the runtime does not read it.

### Manual alternative

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": {
    "@local/idea-board": "link:C:/path/to/plugin-library/plugins/idea-board"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/idea-board"]
    }
  }
}
```

## 3. Development loop

1. Edit `plugins/<name>/` — or `src/client.js` for the two packages that
   generate `client.js`.
2. If the package has a `build` script and you edited `src/client.js`, run
   `npm run build` in that package (or its `--check` mode in CI).
3. `npm test` (whole library) or `npm test` inside one package.
4. `npm run verify` for package-shape and hygiene checks.
5. Restart the app to load the change.

Tests do not need the app: they run on plain Node and are the portability
baseline (see [porting.md](porting.md)).

## 4. Adding a plugin

1. Create `plugins/<name>/package.json` with a unique `@local/<name>` and,
   if it contributes host rows, `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`.
2. Add the client half only if it renders UI; declare `exports["./client"]` and
   `dsh.client.inject`.
3. Add a `test` script and at least one test if the package has logic.
4. Run `npm run link` again and restart.
5. Add a row to the catalog in the root README.

## 5. Profiles and storage

State such as boards, receipts, and tripwire journals lives under `~/.dsh` and
`<workspace>/.dsh`; it is deliberately excluded from this repository. Moving a
profile does not move the library. To unlink a plugin, remove its dependency
and bundle entry (or rerun the script after removing the package directory —
the stale bundle row is pruned).
