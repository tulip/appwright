---
'@tulip/appwright': minor
---

`tap()` now waits for the element to be visible **and enabled** within its timeout. A disabled control accepts the click and ignores it, so a tap that landed while a form was still validating used to pass silently and fail later elsewhere. If the element stays disabled, `tap()` throws `Element "…" is visible but disabled` instead of "not visible". `fill()` and the other actions are unchanged.

New: `locator.isEnabled()`, `waitFor('enabled')` / `waitFor('disabled')`, and `expect(locator).toBeEnabled()` / `toBeDisabled()`. Native elements use WebDriver's `enabled` state; in a WebView an element is disabled when it or an ancestor is `:disabled` or has `aria-disabled="true"`.
