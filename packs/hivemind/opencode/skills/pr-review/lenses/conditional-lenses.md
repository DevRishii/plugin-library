# Conditional Lens Rubrics (4 trigger-activated lenses)

Conditional lenses run only when `selectLensesForFiles` matches a trigger in the changed
file list or content hints. When a conditional lens runs, its findings follow the same
`SubagentReviewReport` contract and severity anchors as the core lenses. When it does not
run, the synthesis records it as `not_triggered` in `lens_coverage` - never as a gap.

---

## 1. `accessibility-ux` - Accessibility & Client UX Semantics
- **Triggers:** `.tsx`, `.jsx`, `.html`, `.css`, `client.js`, `icon.svg`.
- **Owns:** keyboard navigation and focus order, focus trapping/restoration, ARIA roles and
  labels, contrast and state cues, responsive overflow, and screen-reader announcements on
  dynamic updates.
- **Boundary:** Only client UI accessibility and interaction semantics. Layout taste,
  copywriting, and visual redesign are out of scope.
- **BLOCKER / HIGH signals:** a control that is unreachable or unusable by keyboard; a
  modal that traps focus with no escape; an interactive div with no role/label; state
  conveyed by colour alone; an unlabelled icon-only button added by the diff.
- **Evidence:** the JSX/HTML element plus the missing or wrong attribute, quoted verbatim.

## 2. `i18n-localization` - Internationalization & Locale Completeness
- **Triggers:** `locale/`, `i18n`, `en.json`, `zh.json`.
- **Owns:** hardcoded user-facing copy that bypasses locale tables; missing or extra keys
  across sibling locale files; placeholder/interpolation parity; pluralization; UTF-8
  handling and encoding regressions.
- **Boundary:** Only localization keys, cross-locale parity, and text encoding. Tone and
  wording quality stay with the owning feature lens.
- **BLOCKER / HIGH signals:** a new user-facing string hardcoded in a component while
  locale files exist; a key added to one locale but missing in its siblings; mismatched
  `{placeholders}` that throws or prints raw tokens; mojibake introduced in a converted file.
- **Evidence:** the key/string line and, for parity, the sibling locale file's corresponding
  region quoted from the hunk.

## 3. `data-migration` - Schema Migration & Persistent State Safety
- **Triggers:** `.sql`, `migration`, `schema`, `ledger`, `snapshot`.
- **Owns:** forward/backward compatibility with existing on-disk state, journals, or
  databases; migration ordering and rollback; corrupt-state detection versus silent data
  wipe or reset; versioned snapshot readers.
- **Boundary:** Only persistent-state format evolution and migration safety. Query
  performance belongs to `performance-bounds`.
- **BLOCKER / HIGH signals:** a schema change with no reader tolerance for old records;
  destructive `DROP`/`DELETE`/overwrite on startup; migration that assumes a clean store;
  snapshot version bump that old code reads as valid; journal replay that can double-apply.
- **Evidence:** the migration/schema statement or the destructive branch, quoted.

## 4. `llm-prompt-safety` - Agent Prompt Safety, Permissions & Token Discipline
- **Triggers:** `.opencode/`, `opencode/`, `agents/`, `commands/`, `skills/`, `SKILL.md`,
  `AGENTS.md`.
- **Owns:** untrusted `$ARGUMENTS` or external text interpolated into shell blocks or
  unquarantined prompts; overly broad subagent permissions (edit/bash/task) violating least
  privilege; token bloat, unbounded full-file reads, and sequential subagent dispatch where
  one parallel batch applies.
- **Boundary:** Only LLM prompt surfaces, agent permissions, and swarm token discipline.
  Runtime security of the authored code belongs to `security`.
- **BLOCKER / HIGH signals:** user/PR text concatenated into a `bash -c`/shell string;
  a review-only agent granted `edit`, `bash`, or `task`; a prompt that instructs the model
  to ignore its quarantine; a command that fans out workers sequentially in a loop.
- **Evidence:** the offending prompt/permission line, quoted, plus the file it lives in.