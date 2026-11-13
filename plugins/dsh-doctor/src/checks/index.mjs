import { duplicateVersions, lockfileDrift, lockfileMissing, nodeModulesMissing } from './install.mjs';
import { clientBundleStale, duplicatePluginId, engineMismatch, entryMissing } from './plugin.mjs';
import { settingsParse, settingsStalePath, settingsUnknownKey } from './config.mjs';
import { orphanedLock, sessionStoreSize } from './state.mjs';
import { gitignoreMissingState, largeFile } from './workspace.mjs';

/**
 * Check id to implementation map.
 *
 * The manifest in `checks.data.json` names ids; this map supplies behavior.
 * Every id in the manifest must appear here or the registry rejects the load.
 */
export const IMPLEMENTATIONS = {
  'install.lockfile-missing': lockfileMissing,
  'install.node-modules-missing': nodeModulesMissing,
  'install.lockfile-drift': lockfileDrift,
  'install.duplicate-versions': duplicateVersions,
  'plugin.duplicate-id': duplicatePluginId,
  'plugin.engine-mismatch': engineMismatch,
  'plugin.client-bundle-stale': clientBundleStale,
  'plugin.entry-missing': entryMissing,
  'config.settings-parse': settingsParse,
  'config.settings-unknown-key': settingsUnknownKey,
  'config.settings-stale-path': settingsStalePath,
  'state.orphaned-lock': orphanedLock,
  'state.session-store-size': sessionStoreSize,
  'workspace.gitignore-missing-state': gitignoreMissingState,
  'workspace.large-file': largeFile,
};
