import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createContext } from './context.mjs';
import { loadManifest, DoctorError, GROUPS } from './registry.mjs';
import { IMPLEMENTATIONS } from './checks/index.mjs';
import { detectHarnessVersion, runDoctor } from './doctor.mjs';
import { explainCheck, renderExplanation } from './explain.mjs';
import { applyFixes } from './fixes.mjs';
import { exitCodeFor, renderDetails, renderSummary, renderTable, renderWarnings } from './render.mjs';
import { renderChanges } from './changes.mjs';
import { reportToNightmares } from './nightmares.mjs';

export const USAGE = `dsh-doctor — deterministic preflight checks for a DeepSeek Harness workspace

Usage
  dsh-doctor [options]

Options
  --root <dir>                 workspace to inspect (default: current directory)
  --group <name>               limit to one group; repeatable
                               (${GROUPS.join(', ')})
  --check <id>                 limit to one check id; repeatable
  --mute <id>                  suppress one check id; repeatable
  --harness-version <version>  override the detected harness version
  --json                       emit the report as JSON
  --nightmares                 emit only defect findings as backlog-feed JSON;
                               wins over --json and cannot be combined with --fix
  --compare                    diff this run against the previous recorded run
  --strict                     exit 1 when any warn or info is reported
  --fix                        print the dry-run repair plan for every finding
  --yes                        with --fix, apply the mutation fixes
  --explain <id>               explain one check and link its last recorded failure
  --no-history                 do not append to .dsh/doctor/history.jsonl
  --help                       print this message

Exit codes
  0  no failures
  1  at least one failure (or a warning under --strict)
  2  usage error or unreadable workspace
`;

/**
 * Read a repeatable option as a list.
 *
 * @param {string | string[] | undefined} value Parsed option value.
 * @returns {string[]} Values, empty when the option was absent.
 */
function listOf(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Run the CLI without touching process state, so tests and embedders can call it.
 *
 * @param {string[]} argv Arguments after the script name.
 * @param {object} [io] Output sinks and working directory.
 * @param {(text: string) => void} [io.stdout] Standard output sink.
 * @param {(text: string) => void} [io.stderr] Standard error sink.
 * @param {string} [io.cwd] Working directory used when `--root` is absent.
 * @returns {number} Process exit code the caller should adopt.
 */
export function main(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  const cwd = io.cwd ?? process.cwd();

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        root: { type: 'string' },
        group: { type: 'string', multiple: true },
        check: { type: 'string', multiple: true },
        mute: { type: 'string', multiple: true },
        'harness-version': { type: 'string' },
        json: { type: 'boolean', default: false },
        nightmares: { type: 'boolean', default: false },
        compare: { type: 'boolean', default: false },
        strict: { type: 'boolean', default: false },
        fix: { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        explain: { type: 'string' },
        'no-history': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    stderr(`dsh-doctor: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }

  const options = parsed.values;
  if (options.help) {
    stdout(USAGE);
    return 0;
  }

  if (options.nightmares && options.fix) {
    stderr(
      `dsh-doctor: --fix cannot be combined with --nightmares; a run that emits a backlog feed must not repair anything\n\n${USAGE}`,
    );
    return 2;
  }

  const root = resolve(cwd, options.root ?? '.');
  let manifest;
  try {
    manifest = loadManifest(IMPLEMENTATIONS);
  } catch (error) {
    stderr(`dsh-doctor: check manifest is invalid — ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const groups = listOf(options.group);
  const unknownGroup = groups.find((group) => !GROUPS.includes(group));
  if (unknownGroup) {
    stderr(`dsh-doctor: unknown group "${unknownGroup}"; expected one of ${GROUPS.join(', ')}\n`);
    return 2;
  }

  const knownIds = new Set(manifest.checks.map((check) => check.id));
  const unknownId = [...listOf(options.check), ...listOf(options.mute)].find((id) => !knownIds.has(id));
  if (unknownId) {
    stderr(`dsh-doctor: unknown check id "${unknownId}"\n`);
    return 2;
  }

  if (options.explain) {
    const context = createContext({
      root,
      harnessVersion: options['harness-version'] ?? null,
      knownSettingsKeys: manifest.knownSettingsKeys,
    });
    if (!context.harnessVersion) context.harnessVersion = detectHarnessVersion(context);
    try {
      const result = explainCheck({
        id: options.explain,
        checks: manifest.checks,
        context,
        harnessVersion: context.harnessVersion,
      });
      if (options.json) {
        stdout(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        stdout(`${renderExplanation(result, context.harnessVersion)}\n`);
      }
      return 0;
    } catch (error) {
      if (error instanceof DoctorError) {
        stderr(`dsh-doctor: ${error.message}\n`);
        return 2;
      }
      throw error;
    }
  }

  let report;
  try {
    report = runDoctor({
      root,
      harnessVersion: options['harness-version'] ?? null,
      groups,
      only: listOf(options.check),
      mute: listOf(options.mute),
      strict: options.strict,
      compare: options.compare,
      history: options['no-history'] !== true,
      implementations: IMPLEMENTATIONS,
    });
  } catch (error) {
    stderr(`dsh-doctor: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (options.fix) {
    const outcome = applyFixes(report.findings, options.yes === true);
    report.fixRun = outcome;
    if (!options.json) {
      if (outcome.planned.length === 0 && outcome.refused.length === 0) {
        stdout('No failing check has a repair plan.\n\n');
      } else {
        if (outcome.planned.length > 0) {
          stdout(
            `${options.yes ? 'Applied' : 'Dry run — would apply'} ${outcome.planned.length} repair step(s):\n${outcome.planned
              .map((line) => `  ${line}`)
              .join('\n')}\n\n`,
          );
        }
        if (outcome.applied.length > 0) {
          stdout(`Applied:\n${outcome.applied.map((line) => `  ${line}`).join('\n')}\n\n`);
        }
        if (outcome.refused.length > 0) {
          stdout(
            `Not applied automatically (needs the operator):\n${outcome.refused.map((line) => `  ${line}`).join('\n')}\n\n`,
          );
        }
      }
    }
  }

  if (options.nightmares) {
    stdout(`${JSON.stringify(reportToNightmares(report), null, 2)}\n`);
  } else if (options.json) {
    stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout(`${renderTable(report.findings)}\n\n`);
    if (report.changes) stdout(`${renderChanges(report.changes, report.changes.since)}\n\n`);
    const details = renderDetails(report.findings);
    if (details) stdout(`${details}\n\n`);
    const warnings = renderWarnings(report.warnings);
    if (warnings) stdout(`${warnings}\n\n`);
    if (report.historyFile) stdout(`history: ${report.historyFile}\n`);
    stdout(`${renderSummary(report.summary)}\n`);
  }

  return exitCodeFor(report.summary, options.strict === true);
}
