---
'@tulip/appwright': minor
---

`local-device` and `emulator` projects record the device screen for each test that uses the `device` fixture when Playwright's `video` option is set (`on`, `retain-on-failure` or `on-first-retry`), and attach it to the test as `video` so it plays in the html report. `beforeAll`/`afterAll` hooks such as `useCleanDevice()` are not recorded, and a recording that fails to start or stop logs a warning without failing the test. The option is off by default, so existing configs record nothing new.

The Appium server appwright starts now has the bundled ffmpeg at the end of its `PATH`, which both drivers need for screen recording.

Top-level `use` options in `defineConfig` now apply to every project, as they do in Playwright. Previously everything there except `expectTimeout` was dropped, so a top-level `video` (or `trace`, `screenshot`) had no effect; a config that already sets them there starts using them.
