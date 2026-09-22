# Device

Beyond locators, the `device` fixture manages the app under test, reaches files on the device and
opens URLs. Every method works the same on Android and iOS; the per-driver differences (argument
names, container paths, what a real device allows) are handled inside.

## The app under test vs. the foreground app

- `device.getAppBundleId()` — the package name / bundle id of the app under test, read off the
  build. Throws when the provider could not determine it (BrowserStack reports the uploaded app's
  name instead).
- `device.getCurrentBundleId()` — whatever is in the foreground right now: a browser, a system
  dialog, or the app. Leaves the session in the `NATIVE_APP` context, because the underlying
  command is native and fails when routed through a WebView.
- `device.getProvider()` — the project's provider (`emulator`, `local-device`, `browserstack`,
  `lambdatest`). A simulator and a USB phone both report `Platform.IOS`; only this separates them.

## Resetting the app

### `useCleanDevice(options)`

Declare at the top of a `describe` block what state the block needs:

```ts
import { test, useCleanDevice } from '@tulip/appwright';

test.describe.serial('printing', () => {
  useCleanDevice({ appReset: 'reinstall' });
  // ...
});
```

| `appReset`    | What happens before the block                                                    |
| ------------- | -------------------------------------------------------------------------------- |
| `'reinstall'` | Uninstall and reinstall from the project's `buildPath`. Default when no options. |
| `'clearData'` | Keep the install, wipe the app's data. Much faster. iOS simulator only.          |

**Cost.** Playwright instantiates test-scoped fixtures inside a `beforeAll` and tears them down
when the hook ends, so one hook is one Appium session, and a new session is seconds, not
milliseconds. `useCleanDevice` registers exactly one `beforeAll`. Call it once per block, and put
anything else the block needs done on the device into the _same_ hook rather than a second one.
The simplest way is a local wrapper around the `Device` methods, for example a suite that also
has to clear a browser's state before an SSO flow:

```ts
// e2e/utils/clean-device.ts — test-side; the browser part is app-specific
export function useCleanDevice({ appReset = 'reinstall', browser = false } = {}) {
  test.beforeAll(async ({ device }) => {
    if (appReset === 'reinstall') await device.reinstallApp();
    if (browser) await clearBrowserData(device);
  });
}
```

**Ordering.** `beforeAll` hooks run in registration order, so call `useCleanDevice` as the first
statement in the block, before any `beforeAll` of the block's own that expects a fresh app.

**Retries.** A failing test's worker is stopped and the retry runs in a fresh worker, which
re-runs `beforeAll`, so a retry gets a clean device without bookkeeping. A failure inside a
`describe.serial` requeues the whole block, which replays from this hook.

**Versus the session capabilities.** `uninstallAppBeforeTest` / `preserveAppState` in the project
config apply when the Appium session is created and map to `appium:fullReset` / `appium:noReset`,
which mean "reinstall" on Android but "erase the simulator" on iOS. `useCleanDevice` resets per
block, mid-session, and means the same thing on both platforms.

### `device.reinstallApp(buildPath?)`

Terminate, uninstall, install from the build, bring to the foreground. Defaults to the project's
`buildPath`; relative paths resolve against the current working directory. On Android the install
grants the app's runtime permissions, matching the `appium:autoGrantPermissions` the session was
created with, so the next test does not meet a permission prompt. Not available on cloud
providers, where a local build file cannot be installed.

### `device.resetAppData()`

Terminate, wipe the app's data, grant its permissions back (Android — `pm clear` revokes them),
relaunch. iOS simulator only: a real device exposes no data container, so use `reinstallApp()`.

### Building blocks

- `device.clearAppData(appId?)` — wipe an app's data (`pm clear` / the simulator data container).
  Defaults to the app under test; pass another id to clear, say, a browser.
- `device.grantAllPermissions(appId?)` — Android: grant every runtime permission the app declares.
  No-op on iOS.
- `device.isAppInstalled(appId)`.
- `device.terminateApp(appId?)`, `device.activateApp(appId?)`, `device.backgroundApp(seconds)`.

## Files on the device

```ts
const pdf = await device.waitForFile(device.appCachePath('print/out.pdf'), {
  timeout: 30_000,
  isReady: (contents) => contents.subarray(-1024).toString('latin1').includes('%%EOF'),
});
await fs.writeFile(testInfo.outputPath('out.pdf'), pdf);
```

- `device.pullFile(remotePath)` — the file's contents as a `Buffer`.
- `device.waitForFile(remotePath, { timeout, pollInterval, isReady })` — polls `pullFile` until
  the file exists and `isReady` accepts it (default: non-empty). Neither driver distinguishes a
  missing file from a transport fault, so every error is retried and the last one is reported.

Paths inside the app's own container, in the form Appium's file commands take:

| Helper                            | Android              | iOS                                  |
| --------------------------------- | -------------------- | ------------------------------------ |
| `device.appContainerPath('x')`    | `@<package>/x`       | `@<bundle>:data/x`                   |
| `device.appDocumentsPath('x')`    | `@<package>/files/x` | `@<bundle>:data/Documents/x`         |
| `device.appCachePath('x')`        | `@<package>/cache/x` | `@<bundle>:data/Library/Caches/x`    |
| `device.publicDownloadsPath('x')` | `/sdcard/Download/x` | throws — iOS has no shared downloads |

Limits worth knowing before picking a path:

- Android container pulls go through `run-as`, which an emulator allows for any package but a
  real device allows only for a debuggable build. `publicDownloadsPath` sidesteps this.
- iOS container pulls are verified on the simulator. On a real device the driver supports the
  `documents` container alone, putting `Library/Caches` out of reach.
- The iOS container _type_ matters: Appium defaults to `app`, the read-only bundle, while
  everything the app writes lives under `data`. The helpers always address `data`.

## Opening a URL

```ts
const browser = await device.openUrl(`${site}/register`);
// …drive the browser via device.getByText(...) / device.getByLabel(...)
await device.waitForAppToClose(browser);
await device.activateApp();
```

- `device.openUrl(url, { app? })` — opens `url` the way a person tapping a link outside the app
  would: with the platform's default handler, or in `app` (an Android package / iOS bundle id)
  when the app under test itself claims the link. Returns the id of the app that came to the
  foreground. The Appium session stays in the `NATIVE_APP` context, so locators resolve against
  the browser from here on.
- `device.waitForAppToClose(appId, { timeout, pollInterval })` — blocks until `appId` leaves the
  foreground, e.g. a browser closing itself once an auth flow redirects back to the app.

## Escape hatch

`device.executeMobileCommand(command, args)` runs any Appium `mobile:` extension. Prefer the typed
methods above where one exists; they hide the per-driver argument names (`appId` on Android,
`bundleId` on iOS).
