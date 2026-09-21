---
'@tulip/appwright': minor
---

Appwright now covers the Appium plumbing that consumers had been reaching past `Device` for.

**App lifecycle.** `device.reinstallApp()` uninstalls and reinstalls the app under test from the
project's `buildPath` mid-session, identically on both platforms (unlike `appium:fullReset`, which
only applies at session creation and means "erase the simulator" on iOS); on Android the reinstall
keeps the runtime permissions `autoGrantPermissions` gave the app. `device.resetAppData()` is the
faster wipe-in-place variant. `useCleanDevice({ appReset: 'reinstall' | 'clearData' })`, exported
from the package, registers the single `beforeAll` that resets the app for a `describe` block.
Building blocks: `clearAppData`, `grantAllPermissions`, `isAppInstalled`, `getAppBundleId`,
`getProvider`, `executeMobileCommand`.

**Locators.** `device.getByLabel()` / `webView.getByLabel()` find an element by accessibility
label (`content-desc` / `label` / `aria-label`), which no existing locator could; `editable: true`
narrows to text fields. `locator.waitFor('hidden')`, `clear()`, `press(key)` and `inputValue()`
are new. `expect(locator).not.toBeVisible()` now returns as soon as the element is gone.

**Files and URLs.** `device.pullFile()`, `device.waitForFile()` and the container path helpers
(`appContainerPath`, `appDocumentsPath`, `appCachePath`, `publicDownloadsPath`) read files the
app wrote. `device.openUrl()` opens a URL with the platform's default handler and returns the app
that came to the foreground; `device.waitForAppToClose()` waits for it to go away again.

**Migration.**

- `fill()` now **replaces** a field's contents (tap, clear, type, read back) instead of appending
  to them. Anything that used `fill` to append — in particular `fill('\n')` to press Return — must
  become `press('Enter')`. A manual clear before `fill` is no longer needed. Pass
  `{ secret: true }` for passwords so the value stays out of appwright's step titles and error
  messages (the `webdriver` request log is unaffected).
- `getById()` defaults to an **exact** match. Pass `{ exact: false }` to keep substring matching
  (which, on Android, is now a literal substring match; before, the value was interpreted as a
  regular expression).
- `getByText()` and `getById()` escape quotes in the value; a `"` no longer breaks the selector.
- `getCurrentBundleId()` switches the session to the `NATIVE_APP` context before asking, since
  the underlying command fails when routed through a WebView. It does not switch back.
- Methods decorated as Playwright steps no longer throw when called with no test running (worker
  fixtures, unit tests); the step is simply not reported.
