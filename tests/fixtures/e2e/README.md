# End-to-end fixtures

`fresh-repo/` is copied into an OS temp directory by
`scripts/hive/e2e-fixtures.mjs`. The executable suites under `tests/hive/` then
drive the real lifecycle and model-tier CLIs against the copy and delete it in
`t.after`. `tests/fixtures/e2e/tmp/` is reserved for local debugging and ignored
by git; committed tests must keep using OS temp directories so no checkout or
machine path leaks into a fixture.
