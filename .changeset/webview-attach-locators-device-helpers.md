---
'@tulip/appwright': minor
---

Closes the gaps a downstream e2e suite was working around by casting `Device` to its private
WebDriver client or by guessing from the host.

**WebView.** `webView.attach({ context, pageUrl, probeSelector, timeout, settle })` binds the
session to a live page after the app reloads or rebuilds its WebView, after a relaunch, or in a
browser it handed off to. Other `webView` calls only check that some WEBVIEW context is current,
which stays true once the page behind it is gone. What `attach()` bound (the context and, on
Android, the window `page` or `pageUrl` chose) stays bound across native `device` calls while it
lasts and its app or browser is in front; then the next `webView` call logs why and discovers
again. Discovery never binds a browser: with Chrome or a Custom Tab in front,
`attach({ context: 'WEBVIEW_chrome' })` does, and discovery fails within a few seconds saying so.
On Android, when a WebView's renderer drops its connection and chromedriver answers
`invalid session id` while Appium's session lives on, `webView` actions, `evaluate()` and
`attach()` bind again what was bound and retry instead of failing. A window that closed under an
action is recovered the same way. If the window `attach()` chose is gone, they fail saying so
rather than act on another page. The renderer-drop and closed-window recovery and the browser
binding are unit-tested only. `webView.getByRole(role, { name, exact, level })` matches ARIA roles,
explicit and implicit, by accessible name, reading names through `<slot>`s and hidden state through
shadow hosts. Locators chain: `getByText`, `getByRole`, `getByLabel` and `getByTestId` on a
locator look inside its element. `getByTestId()` and `getByPlaceholder()` escape quotes.

**Device.** `getPageSource()` (reads the native tree, restores the WebView), `switchToWindow()` /
`getUrl()`, `getUdid()` (the device this worker's session landed on), a public `isSimulator()`,
`getByIosPredicate()` / `getByAndroidUiAutomator()`, and `getById(id, { editable })`. On an iOS
simulator, `simulatorContainerPath()` and `terminateApp(appId, { force: true })` go through
`xcrun simctl`.

**Rotation, gestures, alerts.** `setOrientation()` rotates mid-test and returns once the driver and
the window shape agree; `getOrientation()` and `getWindowRect()` read them. The `device` fixture
rotates the device back to the configured `device.orientation` after a test that rotated, since a
rotation outlives the session. `drag({ from, to })` and `swipeFromEdge('left' | 'right')` are W3C
touch gestures, and `pressBack()` is Android's back key. `locator.boundingBox()` measures an
element, or returns `null` when it is hidden, as Playwright's does. On iOS, where every provider starts the session with `appium:autoAcceptAlerts`,
`withAlertAutoAccept(false, fn)` / `setAlertAutoAccept()` keep WebDriverAgent from answering the
app's own alerts, and `acceptAlert()` / `dismissAlert()` / `getAlertText()` answer them on both
platforms.

**App and pages.** `getAppState()` (an exported `AppState`) and `getBuildInfo()` (bundle id, version
and build number read off the project's build) need no host-side parsing in the suite.
`webPages()` lists every WebView page the session can see, and `waitForWebPage({ notIn, url })`
waits for a new one — a popup, an OAuth window, a new tab, the WebView an app rebuilt — to load.
`webView.attach({ page })` binds that very page: on Android by its DevTools id, which tells apart two
pages at one URL, and in Chrome, which numbers its tabs instead, by the tab's current URL.

**Locators.** An action (`tap()`, `fill()`, `getText()`, `boundingBox()`, …) acts on the element its
visibility wait found instead of looking it up once more; on iOS every XPath lookup is a
page-source snapshot. If that element went stale in between, it waits and acts once more on the
node that replaced it. A chained locator's visibility wait looks under every one of the parent's
matches while the child's matches so far are hidden. A case-insensitive RegExp in
`device.getByText()` is narrowed case-insensitively (`textMatches("(?is)…")` on Android,
`CONTAINS[c]` on iOS, unit-tested only) rather than to a case-sensitive substring that missed
other casings, and the substring a RegExp is narrowed to has its quotes escaped.

**Package.** `request` and the types `APIRequest`, `APIRequestContext`, `APIResponse` and
`TestInfo` are re-exported from `@playwright/test`. The CLI runs Playwright and Appium by module
resolution rather than `npx`, so their bins need not be hoisted. Appium is the project's own
`appium` when it has one, else appwright's, and the run logs which. Playwright is always
appwright's `@playwright/test`, the one tests import through appwright: a project that pinned a
different `@playwright/test` and ran its CLI through `npx` now runs appwright's.

**Migration.**

- `webView.getByText()` now matches like Playwright's: the element whose whitespace-normalised
  text matches while none of its children's does, instead of `//*[contains(., "x")]`, which
  matched every ancestor up to `<body>` and the page title. A RegExp is now applied as a regular
  expression (before, its source was searched for as a literal substring). Matching stays
  case-sensitive. Its step titles and errors read `getByText("x")` instead of an XPath. A test that
  relied on the old match can spell it out: `webView.getByXpath('//*[contains(., "x")]')`.
- `{ timeout: 0 }` on a locator wait or action (`isVisible()`, `waitFor()`,
  `expect(…).toBeVisible()`, `tap()`, …) makes a single attempt. It used to fall back to the
  project's `expectTimeout`. Playwright reads `0` as no timeout instead.
- `device.getById()` no longer filters several matches by their text, which is not the id: two
  nodes sharing an id used to resolve to no element at all.
- `editable: true` (`getByLabel()`, `getById()`) also matches Android's autocomplete fields, which
  report `AutoCompleteTextView` rather than `EditText` — a `SearchView`'s field is one — and iOS
  search fields (`XCUIElementTypeSearchField`). A label shared by such a field and another text
  field now matches both, and the last one wins.
- A visibility wait, and the action after it, take the last *displayed* match instead of the last
  match: a hidden duplicate later in the page (a closed menu, an off-screen copy) no longer makes
  `tap()` wait on it until "not visible", and the locator counts as hidden only while no match is
  displayed. `expect(locator).not.toBeVisible()` therefore fails while any match is displayed,
  where it used to pass when the last one was hidden. A chained locator does the same across its
  parent's matches.
- `device.getByText(/(save)/i)` now also finds "Save": the driver's search was narrowed
  case-sensitively before, so other casings never matched, and the element that wins can change.
- A `webView` action or `evaluate()` whose window closed under it binds again and retries, as the
  recovery always meant to (it gave up at once). After `attach()` chose that window with `page`
  or `pageUrl`, it fails saying the window is gone instead.
- A closed window or a deleted session found by a locator now surfaces as the driver's own error
  (named `no such window` or `invalid session id`) instead of a `NonRetryableError` copy named
  `NoSuchWindowError`, and errors from `webView` locators keep their class: a `TimeoutError` from
  `webView` stays one, so `expect(webViewLocator).not.toBeVisible()` fails as an assertion
  (and `expect.soft` stays soft) instead of throwing.
- The exported `AppwrightLocator` interface has new required members: `boundingBox()`,
  `getByText()`, `getByRole()`, `getByLabel()` and `getByTestId()`. Code that only calls locators
  is unaffected; a class that `implements AppwrightLocator`, or a typed test double, has to add
  them.
