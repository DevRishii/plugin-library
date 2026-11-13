import { appendLine, removeFiles } from './history.mjs';

/**
 * Build the typed fix plan for a failing check.
 *
 * A fix is one of three kinds. `command` is printed for the operator to run and
 * is never executed here. `mutation` edits the workspace and is only applied
 * when the caller confirms. `manual` needs a human decision and is printed only.
 *
 * @param {object} context Workspace context.
 * @param {string} id Check id.
 * @param {object} finding Failing finding.
 * @returns {{type: string, summary: string, command?: string, steps: string[], apply?: () => string[]} | null}
 *   Fix plan, or `null` when the check has no known repair.
 */
export function planFix(context, id, finding) {
  const evidencePaths = (finding.evidence ?? []).map((item) => item.path).filter(Boolean);
  const pluginDirs = [
    ...new Set(
      evidencePaths
        .map((path) => path.replace(/\/(package\.json|client\.js|index\.js)$/, ''))
        .filter((path) => path !== '' && path !== '.'),
    ),
  ];

  switch (id) {
    case 'install.lockfile-missing':
      return command('pnpm install', ['writes pnpm-lock.yaml from the current package.json']);
    case 'install.node-modules-missing':
      return command('pnpm install', ['installs every declared dependency from the lockfile']);
    case 'install.lockfile-drift':
      return command('pnpm install', ['locks the dependencies that package.json declares but the lockfile omits']);
    case 'install.duplicate-versions':
      return command('pnpm dedupe', ['rewrites the lockfile so one dependency resolves to one version']);
    case 'plugin.engine-mismatch':
      return command(
        'pnpm update --latest',
        pluginDirs.map((dir) => `upgrades ${dir} until its engines.dsh range includes ${context.harnessVersion}`),
      );
    case 'plugin.client-bundle-stale':
      return command(
        `pnpm ${pluginDirs.map((dir) => `--filter ./${dir}`).join(' ')} run build`,
        ['rebuilds each client bundle from the sources it currently lags behind'],
      );
    case 'plugin.entry-missing':
      return command('pnpm install --force', ['restores the entry file the manifest points at']);
    case 'plugin.duplicate-id':
      return manual(
        `remove or rename the duplicate package (${pluginDirs.join(', ')})`,
        [
          'keep one of the reported packages and stop declaring the other',
          'relocate or rename the other package so each plugin id is declared once',
          'dsh-doctor never deletes a plugin directory',
        ],
      );
    case 'config.settings-parse':
      return manual(
        'repair .dsh/settings.json',
        [
          'restore the file from a backup or rewrite it as valid JSON',
          'the harness drops the whole file when it does not parse',
        ],
      );
    case 'config.settings-unknown-key':
      return manual(
        'remove the unrecognized settings keys',
        [
          'delete the reported keys from .dsh/settings.json',
          'unknown keys are ignored, so they read as configured but never take effect',
        ],
      );
    case 'config.settings-stale-path':
      return manual(
        'repair the settings paths',
        ['point the reported settings at a path that exists, or clear the setting'],
      );
    case 'state.orphaned-lock':
      return mutation(
        `remove ${evidencePaths.length} lock files older than ${Math.round(context.stateTtlMs / 60000)} minutes`,
        evidencePaths.map((path) => `delete ${path}`),
        () => {
          const removed = removeFiles(context, evidencePaths);
          return removed.map((path) => `deleted ${path}`);
        },
      );
    case 'workspace.gitignore-missing-state':
      return mutation(
        'ignore .dsh state in .gitignore',
        ['append ".dsh/" to .gitignore'],
        () => {
          appendLine(context, '.gitignore', '.dsh/');
          return ['appended ".dsh/" to .gitignore'];
        },
      );
    case 'state.session-store-size':
      return manual(
        'prune the session store',
        [
          'remove old sessions with the harness session tool before the store grows further',
          'the reported files are the largest contributors',
        ],
      );
    case 'workspace.large-file':
      return manual(
        'move or remove the oversized files',
        ['the reported files are read by every workspace scan, or raise the size budget'],
      );
    default:
      return null;
  }
}

/**
 * Describe a command fix.
 *
 * @param {string} command Command line to print.
 * @param {string[]} steps What the command changes.
 * @returns {object} Command fix plan.
 */
function command(command, steps) {
  return { type: 'command', summary: command, command, steps };
}

/**
 * Describe a fix that requires a human decision.
 *
 * @param {string} summary One-line description.
 * @param {string[]} steps What the operator should do.
 * @returns {object} Manual fix plan.
 */
function manual(summary, steps) {
  return { type: 'manual', summary, steps };
}

/**
 * Describe a fix the tool can apply.
 *
 * @param {string} summary One-line description.
 * @param {string[]} steps Dry-run lines.
 * @param {() => string[]} apply Applies the change and returns what changed.
 * @returns {object} Mutation fix plan.
 */
function mutation(summary, steps, apply) {
  return { type: 'mutation', summary, steps, apply };
}

/**
 * Apply every mutation in a report.
 *
 * Command and manual fixes are never applied: they need the operator.
 *
 * @param {object[]} findings Findings carrying a `fix` plan.
 * @param {boolean} confirm Whether the operator confirmed the repair.
 * @returns {{planned: string[], applied: string[], refused: string[]}} Apply outcome.
 */
export function applyFixes(findings, confirm) {
  const planned = [];
  const applied = [];
  const refused = [];
  for (const finding of findings) {
    const fix = finding.fix;
    if (!fix) continue;
    if (fix.type !== 'mutation') {
      refused.push(`${finding.id}: ${fix.summary}`);
      continue;
    }
    planned.push(...fix.steps.map((step) => `${finding.id}: ${step}`));
    if (!confirm) continue;
    const changes = fix.apply();
    applied.push(...changes.map((change) => `${finding.id}: ${change}`));
  }
  return { planned, applied, refused };
}
