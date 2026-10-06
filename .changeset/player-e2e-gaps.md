---
'@tulip/appwright': minor
---

Closes the gaps the player e2e suite was working around by casting `Device` to its private
WebDriver client or by guessing from the host.

**WebView.** `webView.attach({ context, pageUrl, probeSelector, timeout, settle })` binds the
session to a live page after the app reloads or rebuilds its WebView, after a relaunch, or in a
browser it handed off to. Other `webView` calls only check that some WEBVIEW context is current,
which stays true once the page behind it is gone. With a Chrome Custom Tab in front, discovery now
finds Chrome's `WEBVIEW_chrome` context instead of nothing.
`webView.getByRole(role, { name, exact, level })` matches ARIA roles, explicit and implicit, by
accessible name. Locators chain: `getByText`, `getByRole`, `getByLabel` and `getByTestId` on a
locator look inside its element. `getByTestId()` and `getByPlaceholder()` escape quotes.

**Device.** `getPageSource()` (reads the native tree, restores the WebView), `switchToWindow()` /
`getUrl()`, `getUdid()` (the device this worker's session landed on), a public `isSimulator()`,
`getByIosPredicate()` / `getByAndroidUiAutomator()`, and `getById(id, { editable })`. On an iOS
simulator, `simulatorContainerPath()` and `terminateApp(appId, { force: true })` go through
`xcrun simctl`.

**Package.** `request` and the types `APIRequest`, `APIRequestContext`, `APIResponse` and
`TestInfo` are re-exported from `@playwright/test`. The CLI runs Playwright and Appium from
appwright's own dependencies rather than `npx`, so their bins need not be hoisted.

**Migration.**

- `webView.getByText()` now matches like Playwright's: the element whose whitespace-normalised
  text matches while none of its children's does, instead of `//*[contains(., "x")]`, which
  matched every ancestor up to `<body>` and the page title. A RegExp is now applied as a regular
  expression (before, its source was searched for as a literal substring). Matching stays
  case-sensitive. Its step titles and errors read `getByText("x")` instead of an XPath. A test that
  relied on the old match can spell it out: `webView.getByXpath('//*[contains(., "x")]')`.
- `@empiricalrun/llm` is an optional peer dependency, loaded only by `device.beta.query()` and
  `device.beta.tap()`. Projects that use them must add it with
  `npm install --save-dev @empiricalrun/llm`. `beta.query()`'s `model` option is typed as a
  string. `zod` is now a declared dependency.
- `device.getById()` no longer filters several matches by their text, which is not the id: two
  nodes sharing an id used to resolve to no element at all.
- `editable: true` (`getByLabel()`, `getById()`) also matches Android's autocomplete fields, which
  report `AutoCompleteTextView` rather than `EditText` — a `SearchView`'s field is one. A label
  shared by such a field and an `EditText` now matches both, and the last one wins.
