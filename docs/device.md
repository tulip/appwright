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
- `device.getAppState(appId?)` — an `AppState`: `NotInstalled`, `NotRunning`, `Suspended`,
  `Background` or `Foreground`. Both drivers' terminate already waits for the app to stop, so
  this is how a test proves that a relaunch really relaunched:

  ```ts
  await device.terminateApp();
  expect(await device.getAppState()).toBe(AppState.NotRunning);
  await device.activateApp();
  ```

- `device.getBuildInfo(buildPath?)` — what the project's build file declares: `bundleId`,
  `version` (`CFBundleShortVersionString` / `versionName`), `buildNumber` (`CFBundleVersion` /
  `versionCode`) and `path`, read on the host from the `.app`, `.ipa` or `.apk` (an `.apk` needs
  `ANDROID_HOME`, for `aapt`). Compare it with the version the app shows.

## Which device this is

- `device.getUdid()` — the device the session landed on, as the driver reports it: the adb serial
  (`emulator-5554`) on Android, the device or simulator UDID on iOS. With several devices
  configured, each worker gets its own (see [running on multiple local devices](config.md#running-on-multiple-local-devices)),
  so read it here rather than from an environment variable or `xcrun simctl list`, which cannot
  tell the workers' devices apart.
- `device.isSimulator()` — whether this is an iOS simulator: the one kind of device whose app
  containers are host directories and that `xcrun simctl` can drive. An Android emulator is not
  a simulator here; `getProvider() === 'emulator'` means "not a physical device" on either
  platform.

On a simulator, the host side is reachable directly:

- `device.simulatorContainerPath(relativePath?)` — the host directory behind a path in the app's
  data container, for reading what the app wrote with ordinary `fs` calls. The container is
  named by an install-time UUID, so it is asked of `simctl` each time; a reinstall moves it.
- `device.terminateApp(appId, { force: true })` — kills the process with
  `xcrun simctl terminate` instead of asking WebDriverAgent, which reaches bundle ids XCUITest
  does not treat as apps (`com.apple.SafariViewService`, which hosts an
  `ASWebAuthenticationSession`). Not an error when nothing by that id is running. On Android
  `force` changes nothing — the driver's terminate is already a force-stop — and a physical iOS
  device throws. Keep the plain terminate for the app under test: killed behind WebDriverAgent's
  back, it is reported as crashed until `activateApp()`.

Both throw on anything but a simulator. `appContainerPath()` with `pullFile()` (below) is the
route that works on every device.

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
| `'clearData'` | Keep the install, wipe the app's data. Much faster. Android and iOS simulator.   |

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
relaunch. Android and the iOS simulator; a physical iOS device exposes no data container, so use
`reinstallApp()` there.

### Building blocks

- `device.clearAppData(appId?)` — wipe an app's data (`pm clear` / the simulator data container).
  Defaults to the app under test; pass another id to clear, say, a browser.
- `device.grantAllPermissions(appId?)` — Android: grant every runtime permission the app declares.
  No-op on iOS.
- `device.isAppInstalled(appId)`.
- `device.terminateApp(appId?, { force? })`, `device.activateApp(appId?)`,
  `device.backgroundApp(seconds)`.

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

To drive the page a browser shows rather than its native chrome, bind it with
`webView.attach({ pageUrl })` (see [Attaching to a page](locators.md#attaching-to-a-page)). With
Chrome in front, discovery picks Chrome's `WEBVIEW_chrome` context, so after the browser closes,
attach again to get back to the app's own WebView.

## Pages in WebViews

- `device.webPages()` — every WebView page the session can see, as `{ context, key, url, title }`,
  read natively through `mobile: getContexts` without attaching to any: the app's pages, a
  popup's, and on Android every tab of a browser in front. iOS gives each page its own context;
  Android has one context per WebView or browser, so `key` adds the page's DevTools id.
- `device.waitForWebPage({ notIn, url, timeout })` — waits for a page that is not among `notIn`
  to load, and returns it: a `window.open()` popup, an OAuth window, a new tab. A new page reads
  `about:blank` for about a second first, and does not count until its URL arrives. A page whose
  key or URL is among `notIn` is not new: iOS lists a page under a new context when it reloads.

```ts
const before = await device.webPages();
await webView.getByRole('link', { name: 'Open PDF' }).tap();
const popup = await device.waitForWebPage({ notIn: before, url: '.pdf' });
await webView.attach({ context: popup.context, pageUrl: popup.url });
```

Bind the page with `attach()`: plain discovery binds the first WebView it finds, which on iOS is
the page the popup opened from. Every `device` call that is native leaves the session in
`NATIVE_APP`, after which the next `webView` call discovers again — attach again after native
steps when the page is not the one discovery finds.

## Alerts

On iOS every appwright provider starts the session with `appium:autoAcceptAlerts`, under which
WebDriverAgent taps the last button of **any** alert within about two seconds: system permission
prompts, but also the app's own `Alert.alert` confirmations, before the test can look at them.
Turn it off around a step that has to see or answer an alert:

```ts
await device.withAlertAutoAccept(false, async () => {
  await device.getById('clear-instance-button').tap();
  await expect.poll(() => device.getAlertText()).toContain('Are you sure?');
  await device.acceptAlert({ buttonLabel: 'Clear Data' });
});
```

- `device.withAlertAutoAccept(enabled, fn)` — runs `fn` with auto-accept on or off, then
  restores what the session had (from its capabilities, or an earlier `setAlertAutoAccept()`).
  When `fn` throws, its error is the one reported; a restore that fails after it is only logged.
- `device.setAlertAutoAccept(enabled)` — the same switch without the restore, for a whole block.
- `device.acceptAlert({ buttonLabel? })`, `device.dismissAlert({ buttonLabel? })` — answer the
  alert on screen with its default accept / dismiss button, or the one labelled `buttonLabel`.
- `device.getAlertText()` — the alert's title and message.

Android answers no alert by itself (`appium:autoGrantPermissions` covers permission prompts), so
the auto-accept switch is a no-op there; the answering methods work on both platforms.

## Rotating the device

```ts
const window = await device.setOrientation(DeviceOrientation.LANDSCAPE);
```

- `device.setOrientation(orientation, { timeout? })` — rotates, then returns the window rectangle
  once the rotation has taken effect: the driver reports the new orientation and the window has
  its shape. The project's `device.orientation` applies only when a session starts; this rotates
  mid-test.
- `device.getOrientation()`, `device.getWindowRect()` — what the driver reports. On iOS both
  describe the app in front, so while the home screen is up they read portrait whatever way the
  device is held.

A rotation outlives the session, so after a test that rotated, the `device` fixture rotates the
device back to the project's `device.orientation` (portrait by default), bringing the app under
test to the front first. On iOS the app has to be in front to rotate at all — the home screen is
portrait-only — and a modal that is still animating in refuses too: WebDriverAgent answers
"Unable To Rotate Device", and `setOrientation` reports that rather than retrying it.

## Gestures

Positions are in the driver's units: points on iOS, physical pixels on Android — the units of
`getWindowRect()` and of a native locator's `boundingBox()`.

- `device.drag({ from, to, duration? })` — one finger, with W3C pointer actions: press, hold
  100 ms so the touch reads as a drag rather than a fling, move over `duration` (400 ms by
  default), lift.
- `device.swipeFromEdge('left' | 'right', { inset?, distance?, y?, duration? })` — a swipe in
  from the edge, as for a drawer or the back swipe. `inset` is how far in from the edge the
  finger goes down, in points on iOS and dp on Android (2 by default), so it means the same on
  every screen density; `distance` and `y` are fractions of the window. Safari's history swipe
  ignores synthesized touches, this one and XCUITest's own; navigate in the page instead.
- `device.pressBack()` — Android's back key. Throws on iOS, which has none.

## The software keyboard

- `device.isKeyboardShown()`: whether the software keyboard is on screen. On Android the IME is
  a separate window, so no locator or tree dump can see it.
- `device.hideKeyboard(iosKeyName?)`: dismisses the keyboard if it is up, and throws if it is
  still up afterwards. On iOS the driver taps a dismiss key, `Done` by default; pass the label of
  the keyboard's key for others, such as `hideKeyboard('Return')`. Use it before tapping a
  control below a focused field.

## Inspecting the native tree

`device.getPageSource()` returns the native view hierarchy as XML (UiAutomator2's dump on
Android, XCUITest's on iOS) — the attributes a locator can match on. It is read from
`NATIVE_APP` whatever context is active and then switches back, so calling it between two
`webView` steps leaves the WebView bound. For a page's HTML, use
`webView.evaluate(() => document.documentElement.outerHTML)`.

## Escape hatch

`device.executeMobileCommand(command, args)` runs any Appium `mobile:` extension. Prefer the typed
methods above where one exists; they hide the per-driver argument names (`appId` on Android,
`bundleId` on iOS).
