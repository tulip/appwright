---
'@tulip/appwright': minor
---

Every run now writes its results into its own folders: `test-results/<run>` for Playwright's test output and appwright's video store, and `playwright-report/<run>` for the HTML report, so concurrent runs on one machine (for example iOS and Android side by side) no longer overwrite each other. Name the run with `appwright test --run-name <name>` or `APPWRIGHT_RUN_NAME`; otherwise the folder is named `<project>-<YYYYMMDD>-<HHmmss>-<4 random chars>`.

**Migration.** Results move one level deeper: `test-results/<file>` is now
`test-results/<run>/<file>`, and the HTML report is at `playwright-report/<run>/index.html`.
Anything that reads those paths — CI artifact globs, `playwright show-report`, scripts that open
the report — needs the run folder in the path. Pass `--run-name <name>` (or set
`APPWRIGHT_RUN_NAME`) to make it a fixed, known value. Appwright's video store also moves from
`playwright-report/data/videos-store` to `test-results/<run>/videos-store`.
