---
description: Run a zero-fluff read-only regression and security audit on current uncommitted git changes using @auditor.
agent: auditor
---

Run `git diff` (and `git status --short`) and audit all modified code paths for regressions, race conditions, missing error handling, type holes, or mock fallbacks. Focus area (if any): $ARGUMENTS
