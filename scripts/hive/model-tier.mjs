#!/usr/bin/env node
/**
 * Hivemind model-tier hierarchy guard.
 *
 * Enforces tier(spec-architect) >= tier(builder) + 1 across every Hivemind
 * profile and the baseline agent frontmatter. Zero external dependencies.
 *
 * Works both from a repository checkout and from an installed layout:
 *   <root>/config/model-tiers.json
 *   <root>/packs/hivemind/profiles/*.json   (repository)
 *   <root>/profiles/*.json                  (installed ~/.config/hivemind)
 *   <root>/packs/hivemind/opencode/agents/*.md
 *   <root>/opencode/agents/*.md             (installed mirror)
 *
 * Commands:
 *   resolve --role spec-architect [--profile <id>] [--json]
 *   verify [--strict] [--json]
 *   list-profiles [--json]
 *
 * Exit codes: 0 ok, 1 internal, 2 validation / tier violation / unknown model,
 * 3 registry or profile not found.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ERROR_CODES,
  EXIT_CODES,
  HiveContractError,
  SCHEMA_VERSION,
  emitFailure,
  emitSuccess,
  getLibraryRoot,
  oneLine,
  parseCliArgs,
  readBoundedUtf8,
  resolveRootDir,
} from './contracts.mjs';

/** Roles that must always sit strictly above the builder tier. */
export const ARCHITECT_ROLES = Object.freeze(['hivemind-architect', 'spec-architect']);
export const BUILDER_ROLE = 'builder';
export const TIER_INVARIANT = 'tier(spec-architect) >= tier(builder) + 1';
const TIER_DELTA = 1;
const PROFILE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ROLE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const USAGE = [
  'Usage: model-tier <resolve|verify|list-profiles> [options]',
  '',
  '  resolve --role <role> [--profile <id>] [--json]',
  '  verify [--strict] [--json]',
  '  list-profiles [--json]',
  '',
  'Layout overrides: --root <dir> --home <dir> --config <file>',
  '                  --profiles <dir> --agents <dir> --active-file <file>',
].join('\n');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validation(message, details) {
  return new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.REFUSED, message, details);
}

function unknownModel(message, details) {
  return new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.UNKNOWN_MODEL, message, details);
}

function tierViolation(message, details) {
  return new HiveContractError(EXIT_CODES.VALIDATION, ERROR_CODES.TIER_VIOLATION, message, details);
}

function argPath(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (value === true) throw validation(`--${label} requires a path value`);
  const raw = String(value).trim();
  if (!raw || raw.includes('\0')) throw validation(`invalid --${label} value`);
  return resolvePath(raw);
}

function uniquePaths(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value) continue;
    const key = process.platform === 'win32' ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function firstDirectory(candidates) {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    } catch {
      // ignore unreadable candidates and keep looking
    }
  }
  return candidates[0] ?? null;
}

function firstFile(candidates) {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // ignore unreadable candidates and keep looking
    }
  }
  return candidates[0] ?? null;
}

function listJsonFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    throw validation(`cannot read directory: ${dir}`);
  }
  if (!stat.isDirectory()) throw validation(`not a directory: ${dir}`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.json$/i.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort((left, right) => (left.toLowerCase() < right.toLowerCase() ? -1 : 1));
}

function listMarkdownFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    throw validation(`cannot read directory: ${dir}`);
  }
  if (!stat.isDirectory()) throw validation(`not a directory: ${dir}`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort((left, right) => (left.toLowerCase() < right.toLowerCase() ? -1 : 1));
}

/**
 * Discover the registry, profiles, agents, and active-profile files.
 * Explicit arguments win over repository layout, which wins over an installed
 * `~/.config/hivemind` layout when no root was supplied.
 *
 * @param {Record<string, unknown>} [options]
 */
export function discoverLayout(options = {}) {
  const explicitRoot = options.root ? resolveRootDir(String(options.root)) : null;
  const explicitHome = argPath(options.home, 'home');
  const homeFromEnv = argPath(process.env.HIVEMIND_HOME, 'HIVEMIND_HOME');
  const home = explicitHome ?? homeFromEnv ?? join(homedir(), '.config', 'hivemind');
  const homeIsExplicit = Boolean(explicitHome ?? homeFromEnv);
  const scriptRoot = getLibraryRoot();
  const openCodeDir =
    argPath(process.env.OPENCODE_DIR, 'OPENCODE_DIR') ??
    (homeIsExplicit ? join(home, 'opencode') : join(homedir(), '.config', 'opencode'));

  const roots = uniquePaths([
    explicitRoot,
    explicitHome,
    homeFromEnv,
    !explicitRoot ? scriptRoot : null,
    !explicitRoot && !homeIsExplicit ? home : null,
  ]);

  const configCandidates = options.config
    ? [argPath(options.config, 'config')]
    : uniquePaths(roots.map((root) => join(root, 'config', 'model-tiers.json')));
  const profileCandidates = options.profiles
    ? [argPath(options.profiles, 'profiles')]
    : uniquePaths(
        roots.flatMap((root) => [
          join(root, 'packs', 'hivemind', 'profiles'),
          join(root, 'profiles'),
        ]),
      );
  const agentCandidates = options.agents
    ? [argPath(options.agents, 'agents')]
    : uniquePaths([
        ...roots.flatMap((root) => [
          join(root, 'packs', 'hivemind', 'opencode', 'agents'),
          join(root, 'opencode', 'agents'),
        ]),
        join(openCodeDir, 'agents'),
      ]);

  const activeCandidates = options.activeFile
    ? [argPath(options.activeFile, 'active-file')]
    : uniquePaths([
        ...roots.map((root) => join(root, 'active_profile')),
        !explicitRoot || explicitHome || homeFromEnv ? join(home, 'active_profile') : null,
      ]);

  const configPath = firstFile(configCandidates);
  const profilesDir = firstDirectory(profileCandidates);
  const agentsDir = firstDirectory(agentCandidates);
  const activeFile = firstFile(activeCandidates);

  return {
    root: explicitRoot ?? scriptRoot,
    home,
    openCodeDir,
    configPath,
    configCandidates,
    profilesDir,
    profileCandidates,
    agentsDir,
    agentCandidates,
    activeFile,
  };
}

function normalizeModelId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Strip a UTF-8 BOM left by Windows editors/installers before JSON.parse. */
function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Load and validate `config/model-tiers.json`.
 * @param {Record<string, unknown>} [options]
 */
export function loadModelTiers(options = {}) {
  const layout = options.layout ?? discoverLayout(options);
  const path = layout.configPath;
  if (!path || !existsSync(path)) {
    throw new HiveContractError(
      EXIT_CODES.NOT_FOUND,
      ERROR_CODES.NOT_FOUND,
      `model tier registry not found (looked for ${oneLine((layout.configCandidates ?? []).join(', '))}). ` +
        'Re-run packs/hivemind/install.ps1 or install.sh so scripts/hive/model-tier.mjs and config/model-tiers.json are installed in the Hivemind home.',
      { config_candidates: layout.configCandidates },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(stripBom(readBoundedUtf8(path)));
  } catch (err) {
    if (err instanceof HiveContractError) throw err;
    throw validation(`invalid model tier registry JSON at ${path}: ${err.message}`);
  }
  if (!isPlainObject(parsed)) throw validation('model tier registry must be a JSON object');
  if (parsed.schema_version !== SCHEMA_VERSION) {
    throw validation(
      `unsupported model tier registry schema_version: ${oneLine(parsed.schema_version ?? '<missing>')} (expected ${SCHEMA_VERSION})`,
    );
  }
  if (!isPlainObject(parsed.tiers) || Object.keys(parsed.tiers).length === 0) {
    throw validation('model tier registry must define a non-empty `tiers` map');
  }
  for (const [key, label] of Object.entries(parsed.tiers)) {
    if (!/^[1-9][0-9]*$/.test(key) || !Number.isInteger(Number(key))) {
      throw validation(`invalid tier key: ${key}`);
    }
    if (typeof label !== 'string' || label.trim() === '') {
      throw validation(`tier ${key} must have a non-empty label`);
    }
  }
  if (!isPlainObject(parsed.models) || Object.keys(parsed.models).length === 0) {
    throw validation('model tier registry must define a non-empty `models` map');
  }

  const tiers = Object.freeze(
    Object.fromEntries(
      Object.entries(parsed.tiers)
        .map(([key, label]) => [Number(key), String(label).trim()])
        .sort((left, right) => left[0] - right[0]),
    ),
  );
  const tierNumbers = new Set(Object.keys(tiers).map(Number));

  const models = {};
  for (const [rawId, rawEntry] of Object.entries(parsed.models)) {
    const id = normalizeModelId(rawId);
    if (!id) throw validation('model tier registry contains an empty model id');
    if (!isPlainObject(rawEntry)) throw validation(`model entry '${id}' must be an object`);
    if (!Number.isInteger(rawEntry.tier) || !tierNumbers.has(rawEntry.tier)) {
      throw validation(`model '${id}' must declare an integer tier in ${[...tierNumbers].join(', ')}`);
    }
    if (rawEntry.roles !== undefined && !Array.isArray(rawEntry.roles)) {
      throw validation(`model '${id}' roles must be an array`);
    }
    if (Array.isArray(rawEntry.roles) && rawEntry.roles.some((role) => typeof role !== 'string')) {
      throw validation(`model '${id}' roles must contain only strings`);
    }
    if (rawEntry.notes !== undefined && typeof rawEntry.notes !== 'string') {
      throw validation(`model '${id}' notes must be a string`);
    }
    models[id] = Object.freeze({
      tier: rawEntry.tier,
      roles: Object.freeze([...(rawEntry.roles ?? [])]),
      notes: rawEntry.notes ?? '',
    });
  }

  const roles = {};
  if (parsed.roles !== undefined) {
    if (!isPlainObject(parsed.roles)) throw validation('model tier registry `roles` must be an object');
    for (const [role, rawRule] of Object.entries(parsed.roles)) {
      if (!ROLE_RE.test(role)) throw validation(`invalid role name in registry: ${role}`);
      if (!isPlainObject(rawRule)) throw validation(`role rule '${role}' must be an object`);
      const rule = {};
      for (const bound of ['min_tier', 'max_tier']) {
        if (rawRule[bound] === undefined) continue;
        if (!Number.isInteger(rawRule[bound]) || !tierNumbers.has(rawRule[bound])) {
          throw validation(`role '${role}'.${bound} must be an integer tier`);
        }
        rule[bound] = rawRule[bound];
      }
      if (rule.min_tier !== undefined && rule.max_tier !== undefined && rule.min_tier > rule.max_tier) {
        throw validation(`role '${role}' has min_tier greater than max_tier`);
      }
      roles[role] = Object.freeze(rule);
    }
  }

  const profileOverrides = {};
  if (parsed.profile_overrides !== undefined) {
    if (!isPlainObject(parsed.profile_overrides)) {
      throw validation('model tier registry `profile_overrides` must be an object');
    }
    for (const [profile, rawOverrides] of Object.entries(parsed.profile_overrides)) {
      if (!PROFILE_ID_RE.test(profile)) throw validation(`invalid profile_overrides key: ${profile}`);
      if (!isPlainObject(rawOverrides)) {
        throw validation(`profile_overrides.${profile} must be an object`);
      }
      const overrides = {};
      for (const [role, rawModel] of Object.entries(rawOverrides)) {
        if (!ROLE_RE.test(role)) throw validation(`profile_overrides.${profile} has invalid role: ${role}`);
        const model = normalizeModelId(rawModel);
        if (!model) throw validation(`profile_overrides.${profile}.${role} must be a model id`);
        if (!models[model]) {
          throw unknownModel(
            `profile_overrides.${profile}.${role} references unknown model '${model}'`,
            { profile, role, model },
          );
        }
        overrides[role] = model;
      }
      profileOverrides[profile] = Object.freeze(overrides);
    }
  }

  return Object.freeze({
    path,
    schema_version: parsed.schema_version,
    tiers,
    models: Object.freeze(models),
    roles: Object.freeze(roles),
    profile_overrides: Object.freeze(profileOverrides),
    invariant: typeof parsed.invariant === 'string' ? parsed.invariant : TIER_INVARIANT,
  });
}

function readProfile(path) {
  let parsed;
  try {
    parsed = JSON.parse(stripBom(readBoundedUtf8(path)));
  } catch (err) {
    if (err instanceof HiveContractError) throw err;
    throw validation(`invalid profile JSON at ${path}: ${err.message}`);
  }
  if (!isPlainObject(parsed)) throw validation(`profile ${path} must be a JSON object`);
  if (!isPlainObject(parsed.agent_models) || Object.keys(parsed.agent_models).length === 0) {
    throw validation(`profile ${path} is missing a non-empty agent_models map`);
  }
  const profileId = normalizeModelId(parsed.profile_id) || basename(path, '.json');
  if (!PROFILE_ID_RE.test(profileId)) throw validation(`invalid profile_id in ${path}: ${profileId}`);
  const agentModels = {};
  for (const [role, rawModel] of Object.entries(parsed.agent_models)) {
    if (!ROLE_RE.test(role)) throw validation(`profile '${profileId}' has invalid agent role: ${role}`);
    const model = normalizeModelId(rawModel);
    if (!model) throw validation(`profile '${profileId}' agent '${role}' must name a model`);
    agentModels[role] = model;
  }
  return {
    path,
    profile_id: profileId,
    data: parsed,
    agent_models: agentModels,
  };
}

function applyProfileOverrides(profile, registry) {
  const overrides = registry.profile_overrides[profile.profile_id];
  if (!overrides) return { ...profile, agent_models: { ...profile.agent_models }, overrides: {} };
  const models = { ...profile.agent_models };
  for (const [role, model] of Object.entries(overrides)) {
    if (!(role in models)) {
      throw validation(
        `profile_overrides.${profile.profile_id} names unknown role '${role}' for that profile`,
        { profile: profile.profile_id, role },
      );
    }
    models[role] = model;
  }
  return { ...profile, agent_models: models, overrides: { ...overrides } };
}

/**
 * Load all profile JSON files, validating ids and registry overrides.
 * @param {object} registry
 * @param {Record<string, unknown>} [options]
 */
export function loadProfiles(registry, options = {}) {
  const layout = options.layout ?? discoverLayout(options);
  const files = listJsonFiles(layout.profilesDir);
  if (files.length === 0) {
    throw validation(
      `zero profiles found in ${layout.profilesDir ?? '<no profiles directory>'}; refusing to verify an empty scan`,
      { profiles_dir: layout.profilesDir },
    );
  }
  const profiles = [];
  const seen = new Set();
  for (const file of files) {
    const profile = applyProfileOverrides(readProfile(file), registry);
    if (seen.has(profile.profile_id)) {
      throw validation(`duplicate profile_id '${profile.profile_id}' in ${layout.profilesDir}`);
    }
    seen.add(profile.profile_id);
    profiles.push(profile);
  }
  for (const overrideProfile of Object.keys(registry.profile_overrides)) {
    if (!seen.has(overrideProfile)) {
      throw validation(
        `profile_overrides references unknown profile '${overrideProfile}'`,
        { profile: overrideProfile },
      );
    }
  }
  return profiles.sort((left, right) => (left.profile_id < right.profile_id ? -1 : 1));
}

function modelEntry(registry, model) {
  return Object.prototype.hasOwnProperty.call(registry.models, model) ? registry.models[model] : null;
}

function tierLabel(registry, tier) {
  return registry.tiers[tier] ?? 'unknown';
}

function pushViolation(list, violation) {
  list.push({ code: violation.code ?? ERROR_CODES.TIER_VIOLATION, ...violation });
}

function checkModelRoleRules(registry, scope, owner, role, model, violations) {
  const entry = modelEntry(registry, model);
  if (!entry) {
    pushViolation(violations, {
      code: ERROR_CODES.UNKNOWN_MODEL,
      scope,
      ...owner,
      role,
      model,
      message: `${scope} ${owner.profile ?? owner.agent}: role '${role}' references unknown model '${model}'`,
    });
    return null;
  }
  const rule = registry.roles[role];
  if (rule) {
    if (rule.min_tier !== undefined && entry.tier < rule.min_tier) {
      pushViolation(violations, {
        code: ERROR_CODES.TIER_VIOLATION,
        scope,
        ...owner,
        role,
        model,
        tier: entry.tier,
        message: `${scope} ${owner.profile ?? owner.agent}: role '${role}' model '${model}' tier ${entry.tier} is below min_tier ${rule.min_tier}`,
      });
    }
    if (rule.max_tier !== undefined && entry.tier > rule.max_tier) {
      pushViolation(violations, {
        code: ERROR_CODES.TIER_VIOLATION,
        scope,
        ...owner,
        role,
        model,
        tier: entry.tier,
        message: `${scope} ${owner.profile ?? owner.agent}: role '${role}' model '${model}' tier ${entry.tier} is above max_tier ${rule.max_tier}`,
      });
    }
  }
  return entry;
}

function compareArchitectTiers(registry, scope, owner, models, violations) {
  const builderModel = models[BUILDER_ROLE];
  const builderEntry = builderModel ? modelEntry(registry, builderModel) : null;
  if (!builderModel) {
    pushViolation(violations, {
      code: ERROR_CODES.TIER_VIOLATION,
      scope,
      ...owner,
      role: BUILDER_ROLE,
      message: `${scope} ${owner.profile ?? owner.agent}: missing builder model; cannot verify tier invariant`,
    });
  } else if (!builderEntry) {
    return;
  }
  for (const role of ARCHITECT_ROLES) {
    const architectModel = models[role];
    if (!architectModel) {
      pushViolation(violations, {
        code: ERROR_CODES.TIER_VIOLATION,
        scope,
        ...owner,
        role,
        message: `${scope} ${owner.profile ?? owner.agent}: missing architect role '${role}'; cannot verify tier invariant`,
      });
      continue;
    }
    const architectEntry = modelEntry(registry, architectModel);
    if (!architectEntry || !builderEntry) continue;
    if (architectEntry.tier < builderEntry.tier + TIER_DELTA) {
      pushViolation(violations, {
        code: ERROR_CODES.TIER_VIOLATION,
        scope,
        ...owner,
        role,
        model: architectModel,
        tier: architectEntry.tier,
        builder_model: builderModel,
        builder_tier: builderEntry.tier,
        message:
          `${scope} ${owner.profile ?? owner.agent}: ${role} model '${architectModel}' tier ${architectEntry.tier} ` +
          `must be strictly higher than builder model '${builderModel}' tier ${builderEntry.tier}`,
      });
    }
  }
}

/** Evaluate one profile against the registry (does not throw on compliance). */
export function evaluateProfile(profile, registry) {
  const violations = [];
  const models = profile.agent_models;
  const tiers = {};
  for (const role of Object.keys(models).sort()) {
    const entry = checkModelRoleRules(
      registry,
      'profile',
      { profile: profile.profile_id },
      role,
      models[role],
      violations,
    );
    if (entry) tiers[role] = entry.tier;
  }
  compareArchitectTiers(registry, 'profile', { profile: profile.profile_id }, models, violations);
  return { compliant: violations.length === 0, tiers, violations };
}

function parseFrontmatterModel(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''));
  if (!match) return null;
  const line = /^model:[ \t]*([^\r\n]*)$/m.exec(match[1]);
  if (!line) return null;
  return line[1].trim().replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * Read baseline agent frontmatter (agent name -> model) from the agents dir.
 * @param {object} registry
 * @param {Record<string, unknown>} [options]
 */
export function loadBaseline(registry, options = {}) {
  const layout = options.layout ?? discoverLayout(options);
  const files = listMarkdownFiles(layout.agentsDir);
  const agents = [];
  const violations = [];
  for (const file of files) {
    const agent = basename(file, '.md');
    const model = parseFrontmatterModel(readBoundedUtf8(file));
    if (model === null) continue;
    const entry = checkModelRoleRules(
      registry,
      'baseline',
      { agent },
      agent,
      model,
      violations,
    );
    agents.push({
      agent,
      model,
      tier: entry ? entry.tier : null,
      path: file,
    });
  }
  const modelMap = Object.fromEntries(agents.map((entry) => [entry.agent, entry.model]));
  if (agents.length === 0) {
    pushViolation(violations, {
      code: ERROR_CODES.TIER_VIOLATION,
      scope: 'baseline',
      agent: '<none>',
      message: `no baseline agent frontmatter found in ${layout.agentsDir ?? '<no agents directory>'}; refusing to verify an empty baseline`,
    });
  } else {
    compareArchitectTiers(registry, 'baseline', { agent: 'agents' }, modelMap, violations);
  }
  return {
    agents_dir: layout.agentsDir,
    agents,
    violations,
  };
}

/**
 * Verify every profile plus baseline agent frontmatter.
 * Structural problems (missing registry, malformed JSON, zero profiles, bad
 * overrides) throw. Compliance problems are returned in `violations`.
 *
 * @param {Record<string, unknown>} [options]
 */
export function verifyModelTiers(options = {}) {
  const layout = options.layout ?? discoverLayout(options);
  const registry = options.registry ?? loadModelTiers({ ...options, layout });
  const profiles = options.profileData ?? loadProfiles(registry, { ...options, layout });
  const baseline = options.baseline ?? loadBaseline(registry, { ...options, layout });

  const profileReports = [];
  const violations = [];
  for (const profile of profiles) {
    const evaluation = evaluateProfile(profile, registry);
    violations.push(...evaluation.violations);
    // Switchers persist the raw profile mapping. Validate that mapping as well
    // as resolved overrides so an override cannot hide a downgraded architect.
    if (Object.keys(profile.overrides ?? {}).length > 0) {
      const raw = evaluateProfile({ ...profile, agent_models: profile.data.agent_models, overrides: {} }, registry);
      violations.push(...raw.violations.map(v => ({ ...v, message: `raw switch mapping: ${v.message}` })));
    }
    profileReports.push({
      profile_id: profile.profile_id,
      path: profile.path,
      agent_models: { ...profile.agent_models },
      tiers: evaluation.tiers,
      overrides: profile.overrides ?? {},
      compliant: evaluation.compliant,
      violations: evaluation.violations,
    });
  }
  violations.push(...baseline.violations);

  let activeProfile = '';
  if (layout.activeFile && existsSync(layout.activeFile)) {
    try {
      activeProfile = readBoundedUtf8(layout.activeFile).trim();
    } catch {
      activeProfile = '';
    }
  }

  return {
    ok: violations.length === 0,
    registry_path: registry.path,
    registry_schema_version: registry.schema_version,
    invariant: registry.invariant,
    profiles_dir: layout.profilesDir,
    agents_dir: layout.agentsDir,
    active_profile: activeProfile || null,
    profile_count: profileReports.length,
    profiles: profileReports,
    baseline: {
      agents_dir: baseline.agents_dir,
      agents: baseline.agents.map(({ agent, model, tier }) => ({ agent, model, tier })),
      violations: baseline.violations,
    },
    violations,
  };
}

export const verify = verifyModelTiers;
export const verifyAll = verifyModelTiers;

function firstViolationError(report) {
  const violation = report.violations[0];
  const code = violation?.code === ERROR_CODES.UNKNOWN_MODEL ? ERROR_CODES.UNKNOWN_MODEL : ERROR_CODES.TIER_VIOLATION;
  return new HiveContractError(
    EXIT_CODES.VALIDATION,
    code,
    `${report.violations.length} model-tier violation(s): ${oneLine(violation?.message ?? 'unknown violation')}`,
    report,
  );
}

/** Throw when a verification report contains violations. */
export function assertModelTiers(options = {}) {
  const report = verifyModelTiers(options);
  if (!report.ok) throw firstViolationError(report);
  return report;
}

export const assertModelTierCompliance = assertModelTiers;

function resolveProfileName(layout) {
  const envProfile = normalizeModelId(process.env.HIVE_PROFILE);
  if (envProfile) return envProfile;
  if (layout.activeFile && existsSync(layout.activeFile)) {
    const active = readBoundedUtf8(layout.activeFile).trim();
    if (active) return active;
  }
  const files = listJsonFiles(layout.profilesDir);
  if (files.length === 1) return basename(files[0], '.json');
  throw validation(
    'profile is required: no active_profile found and more than one profile is installed (pass --profile)',
  );
}

function loadProfileByName(name, registry, layout) {
  if (!PROFILE_ID_RE.test(name)) throw validation(`invalid profile id: ${name}`);
  const file = join(layout.profilesDir, `${name}.json`);
  if (!existsSync(file)) {
    throw new HiveContractError(
      EXIT_CODES.NOT_FOUND,
      ERROR_CODES.NOT_FOUND,
      `unknown profile '${name}' (not found at ${file})`,
      { profile: name },
    );
  }
  return applyProfileOverrides(readProfile(file), registry);
}

/**
 * Resolve the concrete model for a profile role and enforce the tier invariant.
 * @param {Record<string, unknown>} [options]
 */
export function resolveModelTier(options = {}) {
  const layout = options.layout ?? discoverLayout(options);
  const registry = options.registry ?? loadModelTiers({ ...options, layout });
  const requestedProfile = normalizeModelId(options.profile);
  const profileName = requestedProfile || resolveProfileName(layout);
  const role = normalizeModelId(options.role) || 'spec-architect';
  if (!ROLE_RE.test(role)) throw validation(`invalid role: ${role}`);

  const profile = loadProfileByName(profileName, registry, layout);
  if (!(role in profile.agent_models)) {
    throw validation(`profile '${profileName}' does not map role '${role}'`, { profile: profileName, role });
  }
  const model = profile.agent_models[role];
  const evaluation = evaluateProfile(profile, registry);
  if (!evaluation.compliant) throw firstViolationError({ violations: evaluation.violations });

  const entry = registry.models[model];
  const builderModel = profile.agent_models[BUILDER_ROLE];
  const builderEntry = builderModel ? registry.models[builderModel] : null;
  const architects = {};
  for (const architectRole of ARCHITECT_ROLES) {
    const architectModel = profile.agent_models[architectRole];
    if (!architectModel) continue;
    const architectEntry = registry.models[architectModel];
    architects[architectRole] = {
      model: architectModel,
      tier: architectEntry?.tier ?? null,
      tier_label: architectEntry ? tierLabel(registry, architectEntry.tier) : 'unknown',
    };
  }

  return {
    profile: profileName,
    role,
    model,
    tier: entry.tier,
    tier_label: tierLabel(registry, entry.tier),
    builder: builderModel
      ? {
          model: builderModel,
          tier: builderEntry?.tier ?? null,
          tier_label: builderEntry ? tierLabel(registry, builderEntry.tier) : 'unknown',
        }
      : null,
    architects,
    overrides: profile.overrides ?? {},
    invariant: registry.invariant,
    compliant: true,
  };
}

export const resolve = resolveModelTier;
export const resolveRoleModel = resolveModelTier;

/**
 * List every installed profile with resolved tiers and compliance status.
 * @param {Record<string, unknown>} [options]
 */
export function listProfiles(options = {}) {
  const layout = options.layout ?? discoverLayout(options);
  const registry = options.registry ?? loadModelTiers({ ...options, layout });
  const profiles = loadProfiles(registry, { ...options, layout });
  const active = layout.activeFile && existsSync(layout.activeFile)
    ? readBoundedUtf8(layout.activeFile).trim()
    : '';
  return {
    ok: true,
    registry_path: registry.path,
    profiles_dir: layout.profilesDir,
    active_profile: active || null,
    count: profiles.length,
    profiles: profiles.map((profile) => {
      const evaluation = evaluateProfile(profile, registry);
      return {
        profile_id: profile.profile_id,
        path: profile.path,
        agent_models: { ...profile.agent_models },
        tiers: evaluation.tiers,
        overrides: profile.overrides ?? {},
        compliant: evaluation.compliant,
        violations: evaluation.violations,
      };
    }),
  };
}

export const listProfileNames = (options = {}) =>
  listProfiles(options).profiles.map((profile) => profile.profile_id);

function boolFlag(flags, name) {
  return flags[name] === true || flags[name] === 'true' || flags[name] === '1';
}

function stringFlag(flags, name) {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (value === true) throw validation(`--${name} requires a value`);
  return String(value);
}

function optionsFromFlags(flags) {
  return {
    root: stringFlag(flags, 'root'),
    home: stringFlag(flags, 'home'),
    config: stringFlag(flags, 'config'),
    profiles: stringFlag(flags, 'profiles'),
    agents: stringFlag(flags, 'agents'),
    activeFile: stringFlag(flags, 'active-file'),
    profile: stringFlag(flags, 'profile'),
    role: stringFlag(flags, 'role'),
  };
}

function emitVerify(report, ctx) {
  if (ctx.json) {
    if (report.ok) {
      emitSuccess(ctx, report);
    } else {
      const error = firstViolationError(report);
      emitFailure(ctx, error.code, error.message, EXIT_CODES.VALIDATION, report);
    }
    return report.ok ? EXIT_CODES.OK : EXIT_CODES.VALIDATION;
  }
  if (report.ok) {
    const text =
      `model-tier verify: OK (${report.profile_count} profiles, ` +
      `${report.baseline.agents.length} baseline agents, 0 violations)`;
    if (!ctx.quiet) process.stdout.write(`${text}\n`);
    return EXIT_CODES.OK;
  }
  for (const violation of report.violations) {
    process.stderr.write(`violation [${violation.code}]: ${oneLine(violation.message)}\n`);
  }
  return EXIT_CODES.VALIDATION;
}

/**
 * CLI entry point.
 * @param {string[]} [argv]
 * @param {{ json?: boolean, quiet?: boolean }} [runtime]
 */
export function runCli(argv = process.argv.slice(2), runtime = {}) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof HiveContractError) {
      emitFailure(runtime, err.code, err.message, err.exitCode);
      return err.exitCode;
    }
    throw err;
  }
  const { flags, positionals } = parsed;
  const ctx = { json: boolFlag(flags, 'json') || runtime.json === true, quiet: boolFlag(flags, 'quiet') || runtime.quiet === true };
  const command = positionals[0] ?? (flags.help ? 'help' : 'verify');

  if (flags.help || command === 'help' || command === '--help' || command === '-h') {
    if (!ctx.quiet) process.stdout.write(`${USAGE}\n`);
    return EXIT_CODES.OK;
  }
  if (!['resolve', 'verify', 'list-profiles', 'list', 'check'].includes(command)) {
    emitFailure(ctx, ERROR_CODES.REFUSED, `unknown command '${command}'. ${USAGE}`, EXIT_CODES.VALIDATION);
    return EXIT_CODES.VALIDATION;
  }

  try {
    const options = optionsFromFlags(flags);
    if (command === 'resolve') {
      const data = resolveModelTier(options);
      const text = `${data.profile}/${data.role} -> ${data.model} (tier ${data.tier} ${data.tier_label})`;
      emitSuccess(ctx, data, text);
      return EXIT_CODES.OK;
    }
    if (command === 'list-profiles' || command === 'list') {
      const data = listProfiles(options);
      const lines = data.profiles.map((profile) => {
        const architect = profile.tiers['spec-architect'] ?? '?';
        const builder = profile.tiers.builder ?? '?';
        const mark = profile.profile_id === data.active_profile ? '*' : ' ';
        return `${mark} ${profile.profile_id}: spec-architect tier ${architect} > builder tier ${builder}${profile.compliant ? '' : ' [VIOLATIONS]'}`;
      });
      emitSuccess(ctx, data, lines.join('\n'));
      return EXIT_CODES.OK;
    }
    return emitVerify(verifyModelTiers(options), ctx);
  } catch (err) {
    if (err instanceof HiveContractError) {
      emitFailure(ctx, err.code, err.message, err.exitCode, err.details);
      return err.exitCode;
    }
    emitFailure(ctx, ERROR_CODES.INTERNAL, `internal error: ${oneLine(err?.message ?? err)}`, EXIT_CODES.INTERNAL);
    return EXIT_CODES.INTERNAL;
  }
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
