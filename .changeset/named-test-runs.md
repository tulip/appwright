---
'@tulip/appwright': minor
---

Every run now writes its results into its own folders: `test-results/<run>` for Playwright's test output and appwright's video store, and `playwright-report/<run>` for the HTML report, so concurrent runs on one machine (for example iOS and Android side by side) no longer overwrite each other. Name the run with `appwright test --run-name <name>` or `APPWRIGHT_RUN_NAME`; otherwise the folder is named `<project>-<YYYYMMDD>-<HHmmss>-<4 random chars>`.
