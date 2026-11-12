---
'@tulip/appwright': minor
---

`local-device` and `emulator` projects record the device screen for each test that uses the `device` fixture when Playwright's `video` option is set (`on`, `retain-on-failure` or `on-first-retry`), and attach it to the test as `video` so it plays in the html report. `beforeAll`/`afterAll` hooks such as `useCleanDevice()` are not recorded. A recording that fails to start or stop logs a warning without failing the test, and after a failed start the worker stops trying. Recordings stop after 15 minutes, and Android records at 1.5 Mbps so a full recording can still be returned in one piece. Unit-tested, and run on an Android emulator (`on`, `retain-on-failure`, `on-first-retry`) and an iOS simulator (`on`); physical devices were not tried.

The Appium server appwright starts now has the bundled ffmpeg at the end of its `PATH`, which both drivers need for screen recording.

Top-level `use` options in `defineConfig` now apply to every project, as they do in Playwright. Previously everything there except `expectTimeout` was dropped.

**Migration.** Two kinds of config record or behave differently after upgrading, with no change on your side:

- A `local-device` or `emulator` project that already sets `video` (in a project's `use`, where it had no effect on device tests, or at the top level) now records its tests. That adds a recording start and stop to every test, and iOS projects need ffmpeg with `libx264` (the bundled one has it). Remove `video` or set it to `"off"` to keep the old behaviour.
- Every key in the top-level `use` now reaches every project that does not set its own, not only `video`, `trace` and `screenshot`. A leftover top-level `device`, `platform`, `buildPath`, `appBundleId` or `actionTimeout` now applies to those projects; move such keys into the projects that need them, or delete them.

Configs with no top-level `use` and no `video` are unaffected.
