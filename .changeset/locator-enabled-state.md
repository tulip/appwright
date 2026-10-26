---
'@tulip/appwright': minor
---

Locator actions now run Playwright-style actionability checks.

- `tap()` waits for the element to be visible **and enabled** within its timeout, then taps that same element. A disabled control accepts a click and ignores it, so a tap that landed while a form was still validating used to pass silently and fail later elsewhere. If the element stays disabled, `tap()` throws `Element "…" is visible but disabled after …ms. Pass { force: true } to tap anyway.`
- `tap({ force: true })` skips the checks and taps as soon as the element exists. `tap({ trial: true })` runs the checks without tapping.
- If the driver refuses an action because the element is stale, covered (`element click intercepted`) or not interactable, the checks run again within what is left of the timeout. This applies to `tap`, `fill`, `clear`, `press`, `sendKeyStrokes`, `getText`, `inputValue`, `boundingBox` and `isEnabled`. When the refusals outlast the timeout, the error keeps the driver error's `name`, so a `stale element reference` check on `error.name` still matches.
- Actions act on the element they checked, instead of finding it a second time.
- Waits poll at once, then after 100, 250 and 500 ms, then every second, instead of once a second. A missing element's error now ends with `: nothing matches the selector`.

New: `locator.isEnabled()`, `waitFor('enabled')` / `waitFor('disabled')`, and `expect(locator).toBeEnabled()` / `toBeDisabled()`. Native elements use WebDriver's `enabled`. In a WebView, Playwright's rules apply: text is retargeted to its button, then native `:disabled` and the nearest `aria-disabled` decide.
