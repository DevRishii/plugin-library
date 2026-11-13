# dsh-doctor

## What it is

dsh-doctor is a deterministic preflight for a DeepSeek Harness workspace. It reads files under a workspace root, runs 15 fixed checks, and reports each outcome as a status, a summary, and evidence. It does not call a model, open a network connection, or give general advice: every finding is the result of one named check and carries the paths it inspected.

The check list and its metadata live in `src/checks.data.json`. The implementations live in `src/checks/`. The CLI entry point is `main` in `src/cli.mjs`; `bin/dsh-doctor.mjs` is a shim that adopts its return value as the exit code.

## Quick start

Run from the package directory:

```sh
node ./bin/dsh-doctor.mjs
```

Inspect a different workspace:

```sh
node ./bin/dsh-doctor.mjs --root <path>
```

The package requires Node.js 22 or newer, per `engines` in `package.json`.

## Flags

| Flag | Meaning | Default |
| --- | --- | --- |
| `--root <dir>` | Workspace directory to inspect. | Current directory |
| `--group <name>` | Limit to one group; repeatable. Accepted: `install`, `plugin`, `config`, `state`, `workspace`. | All groups |
| `--check <id>` | Limit to one check id; repeatable. | All checks |
| `--mute <id>` | Suppress one check id; repeatable. The check is still listed as `skip`. | None |
| `--harness-version <version>` | Override the detected harness version used for check gating. | Detected from the workspace |
| `--json` | Emit the report as JSON instead of text. | Off |
| `--nightmares` | Emit only defect findings as one backlog-feed JSON object. Wins over `--json`; cannot be combined with `--fix`. | Off |
| `--compare` | Diff this run against the previous recorded run. Requires history. | Off |
| `--strict` | Exit 1 when any warn or info is reported. | Off |
| `--fix` | Print the repair plan for every failing finding. | Off |
| `--yes` | With `--fix`, apply mutation fixes. Ignored without `--fix`. | Off |
| `--explain <id>` | Explain one check and link its last recorded failure. | None |
| `--no-history` | Do not append to `.dsh/doctor/history.jsonl`. | Off |
| `--help` | Print usage and exit 0. | Off |

## Exit codes

- `0`: no check failed. A successful `--help` or `--explain` also returns 0.
- `1`: at least one check failed, or `--strict` was set and any warn or info was reported. The `exitCode` field in the JSON report follows the same rule.
- `2`: usage error or unreadable workspace. This covers an unknown flag, a positional argument, an unknown `--group`, an unknown `--check` or `--mute` id, an invalid check manifest, a missing `--root`, and an unknown `--explain` id.

Run-level `warning:` lines do not affect the exit code.

## Output

The text report starts with a table of STATUS, SEVERITY, GROUP, CHECK, and SUMMARY. With `--compare` it then prints one line per difference from the previous recorded run — `changed`, `new`, or `gone` — or `changes: none since <timestamp>`. It then prints one detail block for every finding that is not `pass` and, for `skip`, only when it has evidence. Each evidence line reads `at <path>` or `at <path>:<line>`, followed by the evidence detail when present. A failing finding with a repair plan also prints `fix (<type>): <summary>` and its steps, prefixed `would` for a mutation and `then` for a command or manual fix. The report ends with any run-level warnings, a `history:` line when a record was appended, and a count line such as `2 pass · 0 info · 0 warn · 0 fail · 13 skip (15 checks)`.

`--json` prints the whole report, indented by two spaces:

- `tool`: always `dsh-doctor`.
- `generatedAt`: ISO timestamp for the run.
- `root`: absolute path of the inspected workspace.
- `harnessVersion`: detected or overridden version, or `null`.
- `findings`: array of findings.
- `summary`: counts for `pass`, `info`, `warn`, `fail`, `skip`, and `total`.
- `warnings`: run-level warning strings.
- `changes`: present only with `--compare`; `since` plus `added`, `changed`, and `removed` arrays.
- `exitCode`: `0` or `1`.
- `historyFile`: present only when a history record was appended.
- `fixRun`: present only with `--fix`; contains the `planned`, `applied`, and `refused` string arrays.

Each finding has `id`, `group`, `severity`, `title`, `status`, `summary`, `evidence`, and `fix`. Status is one of `pass`, `info`, `warn`, `fail`, or `skip`; a failed check maps its declared severity to `fail`, `warn`, or `info`. Evidence is an array of `{ path, detail }` objects, where `path` is workspace-relative and names the file or directory that failed. An optional `line` on an evidence item is rendered as `path:line`. `fix` is `null` unless the check failed and has a repair plan.

`--nightmares` replaces the report with one JSON object for a backlog board: `source` is always `dsh-doctor`, `generatedAt` and `harnessVersion` come from the run, `findings` holds only entries whose status is not `pass` or `skip`, keeping each one's `id`, `group`, `severity`, `title`, `status`, `summary`, `evidence`, and `fix`, and `passing` lists the ids of the checks that ran and passed. A consumer uses `passing` to close a backlog entry whose defect no longer reproduces. The object is still printed when `findings` is empty, so a consumer can distinguish "everything passed" from a failed invocation. It composes with `--root`, `--group`, `--check`, `--harness-version`, and `--mute`; it wins over `--json`; and it exits 2 with `--fix`, because a run that emits a feed must not repair anything. Exit codes are unchanged.

## The checks

All 15 checks, with ids exactly as declared in `src/checks.data.json`.

| id | group | severity | harness range | What it proves |
| --- | --- | --- | --- | --- |
| `install.lockfile-missing` | install | error | `*` | A `package.json` that declares dependencies is backed by `pnpm-lock.yaml`, `package-lock.json`, or `yarn.lock`. |
| `install.node-modules-missing` | install | error | `*` | `node_modules` exists at the root whenever dependencies are declared. |
| `install.lockfile-drift` | install | error | `*` | Every declared dependency name appears in the first lockfile found. |
| `install.duplicate-versions` | install | warn | `>=0.2.0 <0.3.0` | No package in `node_modules/.pnpm` is installed at more than one version. |
| `plugin.duplicate-id` | plugin | error | `>=0.2.0` | No two discovered plugins declare the same package name. |
| `plugin.engine-mismatch` | plugin | error | `>=0.2.0 <0.4.0` | Every plugin that declares `engines.dsh` accepts the installed harness version. |
| `plugin.client-bundle-stale` | plugin | warn | `*` | Each plugin's `client.js` is not older than its `package.json`, `index.js`, or `src`. |
| `plugin.entry-missing` | plugin | warn | `*` | Each discovered plugin names a loadable entry (`main` or an export) that exists on disk. |
| `config.settings-parse` | config | error | `*` | `.dsh/settings.json`, when present, parses as JSON. |
| `config.settings-unknown-key` | config | warn | `>=0.2.0 <0.5.0` | Every top-level settings key is in the manifest's `knownSettingsKeys` list. |
| `config.settings-stale-path` | config | warn | `*` | Every string settings value that looks like an absolute path exists. |
| `state.orphaned-lock` | state | warn | `*` | No `*.lock` file up to six levels below `.dsh` is older than 30 minutes. |
| `state.session-store-size` | state | info | `>=0.2.0` | `.dsh/sessions` totals at most 50 MiB. |
| `workspace.gitignore-missing-state` | workspace | warn | `*` | `.gitignore`, when present, has a line ignoring `.dsh` or `.dsh/`. |
| `workspace.large-file` | workspace | info | `*` | No file at the workspace root exceeds 5 MiB. |

## Fix semantics

A fix is one of three types.

`command` is a shell command printed for the operator and never executed by dsh-doctor. Its plan lists what the command changes. Seven checks use it: `install.lockfile-missing`, `install.node-modules-missing`, and `install.lockfile-drift` (`pnpm install`), `install.duplicate-versions` (`pnpm dedupe`), `plugin.engine-mismatch` (`pnpm update --latest`), `plugin.client-bundle-stale` (a filtered `pnpm ... run build`), and `plugin.entry-missing` (`pnpm install --force`).

`mutation` is the only type the tool can apply, and only two checks have one: `state.orphaned-lock`, which deletes the stale lock files named in its evidence (paths outside the workspace root are skipped), and `workspace.gitignore-missing-state`, which appends `.dsh/` to `.gitignore`. With `--fix` alone, the steps are printed as a dry run and nothing changes. With `--fix --yes`, each mutation is applied: text output lists the changes under `Applied:`, JSON lists them in `fixRun.applied`, and the dry-run steps remain in `fixRun.planned` either way.

`manual` needs a human decision. These six checks use it: `plugin.duplicate-id`, `config.settings-parse`, `config.settings-unknown-key`, `config.settings-stale-path`, `state.session-store-size`, and `workspace.large-file`. Their plans are printed under `Not applied automatically (needs the operator):` and appear in `fixRun.refused`, never in `applied`. The tool never deletes a plugin directory; the duplicate-id steps tell the operator to remove, rename, or relocate a package and state that explicitly.

Fix plans are computed from the run that just finished. Applying a mutation does not re-run the checks or change the findings or the history record for that run.

## History and `--explain`

Unless `--no-history` is passed, every run appends one JSON line to `.dsh/doctor/history.jsonl`, creating the directory when needed. The directory is created before the checks run, so a recorded run cannot change the result of the next one. The record holds `generatedAt`, `harnessVersion`, `summary`, and each finding's `id`, `status`, `severity`, `summary`, and `evidence`. The file is append-only: dsh-doctor never rewrites or prunes it, and unparsable lines are ignored when the log is read.

`--explain <id>` prints the check's title, group, severity, declared harness range, and reason for existing, then whether the check applies to the installed harness today. It then prints the last recorded failure for that id with its status, summary, evidence locations, and the link `log: .dsh/doctor/history.jsonl:<line>`, where `<line>` is the record's line in that log. Up to four earlier recorded failures are listed with their own `path:line` links. A check with no recorded failure prints that nothing is recorded. With `--json`, the explanation contains `check`, `latest`, `occurrences`, and `inapplicable`. `--explain` does not append history, and `--no-history` omits the `historyFile` field from a normal report.

## Version gating

Each check declares a `harness` range in `src/checks.data.json`. A check is selected only when its range is `*`, or when the installed harness version is known and satisfies the range. Otherwise it is reported as `skip` with the reason, for example `applies to harness >=0.2.0 <0.3.0, installed 0.4.0`. When the version is unknown, every ranged check is skipped and the report carries a run-level warning; this keeps a stale check from staying active after an upgrade.

Detection reads the `version` field from `dsh-src/package.json` first, then from a root `package.json` whose `name` starts with `@deepseek-ai/dsh`. If neither yields a version, `harnessVersion` is `null`. `--harness-version` overrides detection and is also used by `--explain` to report applicability.

Selection differs by cause: `--group` and `--check` omit checks from the report entirely, while `--mute` and version gating keep them as `skip` findings with a reason.

## Verification

Run both from the package directory:

```sh
npm test
node ./bin/dsh-doctor.mjs --no-history
```

`npm test` runs `node --test --test-isolation=none "test/*.test.mjs"`. The explicit glob and the disabled per-file isolation matter in confined Windows sandboxes, where the test runner's own child-process spawn and anonymous pipes are denied; in an unrestricted shell `node --test test/` also works. The second command runs the CLI without appending to the history log.

## Known limitations

- Lockfile drift is a text-membership heuristic. It proves that a dependency name appears in the lockfile text; it does not prove which version resolved, and it does not compare versions.
- Plugin discovery scans only the workspace root, `node_modules/@local`, and `node_modules/@deepseek-ai`, one directory level deep. A plugin elsewhere is invisible to all plugin checks.
- A package counts as a plugin only when it declares `main`, a `.` export, or an `@deepseek-ai/cordis` dependency in `dependencies`, `devDependencies`, or `peerDependencies`. Packages without one of these are not reported.
- Client-bundle staleness compares file modification times: `client.js` against `package.json`, `index.js`, and `src`. A bundle rebuilt from stale sources still looks fresh.
- dsh-doctor never repairs a `command` or `manual` fix itself, and mutation fixes are limited to the two checks listed above. It also does not re-run checks after applying a mutation.
- The 30-minute lock TTL and the 5 MiB and 50 MiB size budgets are internal defaults; no CLI flag changes them.
- The history log is never rotated. One run adds roughly 2–3 KiB, and `--compare` reads only the last record.
