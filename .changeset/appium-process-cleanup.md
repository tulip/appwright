---
'@tulip/appwright': patch
---

The shared Appium server is now started as `node <appium>/index.js` instead of `npx appium`. `npx` does not pass SIGKILL on to Appium, so a run that was killed, timed out during startup or hit a port clash left Appium listening on its port. Appium is resolved from the working directory first, as `npx` did, then from appwright's own dependency.

Once the server is up, its output no longer decides anything: a later `EADDRINUSE` line (for example from a session's chromedriver) used to kill the running shared server. The exit guard also kills a server that is still running after teardown's SIGTERM.

If global setup fails after Appium started or an emulator booted (for example a later `--project` failing the workers check), both are stopped before the error is reported; previously they kept running.
