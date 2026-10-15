# Locators

Locators in Appwright are used to select and interact with elements within your mobile app.

## How to select an Element

In Appwright, you can select an element on the screen using the `device` object. The `device` object provides various methods to locate elements by text, ID, or XPath. Here's how you can select elements:

### Get an element by Text

You can use the `getByText` method to select elements by their visible text on the screen.

```ts
const element = await device.getByText('Submit');
```

Above method defaults to a substring match, and this can be overridden by setting the `exact` option to `true`.

```ts
const element = await device.getByText('Submit', { exact: true });
```

We can also use the `getByText` method to select elements using `Regex` patterns.

```ts
const counter = device.getByText(/^Counter: \d+/);
```

### Get an element by ID

You can use the `getById` method to select elements by their accessibility identifier (`resource-id` on Android, `name` on iOS). React Native's `testID` lands here on both platforms.

```ts
const element = await device.getById('signup_button');
```

Above method defaults to an exact match, and this can be overridden by setting the `exact` option to `false` for a substring match.

```ts
const element = await device.getById('signup', { exact: false });
```

### Get an element by accessibility label

You can use the `getByLabel` method to select elements by their accessibility label (`content-desc` on Android, `label` on iOS). React Native's `accessibilityLabel` lands here on both platforms. Neither `getByText` (which reads the `text` attribute on Android) nor `getById` can find an element that only carries a label.

```ts
await device.getByLabel('Settings').tap();
```

Above method defaults to an exact match; set `exact: false` for a substring match. A label is user-facing copy and moves with wording and i18n changes, so prefer `getById` where the app exposes a `testID`.

Pass `editable: true` to restrict the match to text fields. On iOS a web page rendered natively repeats one label across the field's wrapper, its StaticText and the input itself, and a bare label match can land `fill` on the StaticText.

```ts
await device.getByLabel('Station Name', { editable: true }).fill('Line 1');
```

### Get an element by XPath

You can use the `getByXpath` method to select elements by their XPath on the screen.

```ts
const element = await device.getByXpath(`//android.widget.Button[@text="Confirm"]`);
```

## How to Take Actions on the Element

### Tapping an element

To tap an element, you can use the `tap` method.

```ts
await device.getByText('Submit').tap();
```

Like Playwright's and Cypress's click, `tap` runs actionability checks first. Within the action's timeout it waits for the element to be visible **and enabled**, then taps that same element. A disabled button accepts a click and does nothing, so without the check a tap that lands while a form is still validating passes, and the test fails later somewhere else. See [enabled state](#check-whether-an-element-is-enabled) for what counts as disabled.

If the driver refuses the tap because the element went stale, is covered (`element click intercepted`) or is not interactable, the checks run again within what is left of the timeout. When the timeout runs out, the error says what the last check saw:

| Error | Meaning |
| --- | --- |
| `not visible after …: nothing matches the selector` | the locator found nothing |
| `not visible after …` | found, but not displayed |
| `is visible but disabled after … Pass { force: true } to tap anyway.` | found and displayed, still disabled |
| `could not be used after …: <driver error>` | passed the checks, but the driver kept refusing the tap |

Two options change this:

```ts
// Tap as soon as the element exists, skipping the visible/enabled checks.
await device.getByText('Submit').tap({ force: true });

// Run the checks without tapping: resolves when a tap would happen, throws the same error otherwise.
await webView.getByText('Next').tap({ trial: true });
```

`fill`, `clear`, `press`, `sendKeyStrokes`, `getText` and `inputValue` run the same loop, but wait only for visibility. They also act on the element they checked, and retry when the driver reports it stale.

All of these waits poll at once, then after 100, 250 and 500 ms, then every second, with a last check at the deadline.

### Enter text in a text field

To enter text into an element, you can use the `fill` method. It **replaces** the field's contents: it taps the field, clears it, types the value and reads it back, retrying once if the field did not take the whole value (iOS drops leading characters when a field takes focus mid-send).

On iOS `fill` taps the field first, because XCUITest refuses keys to a field that never raised the keyboard, so the keyboard is up afterwards. On Android and in a WebView it sets the value without tapping. Whenever the keyboard is up, remember that it can cover controls near the bottom of the screen, and that some screens swallow the first tap outside a focused field to dismiss it. Call `device.hideKeyboard()` before tapping the next control, or submit with `press('Enter')`.

`fill` throws if the field does not hold exactly the value afterwards. For a field that legitimately changes what was typed (an input mask, auto-formatting, `maxLength`, iOS autocorrect), pass `verify: false` and assert what you expect with `inputValue()`:

```ts
await device.getById('phone').fill('5551234567', { verify: false });
expect(await device.getById('phone').inputValue()).toBe('(555) 123-4567');
```

```ts
await device.getByText('Search').fill('Wikipedia');
```

For a password, pass `secret: true`. The value is then hidden from the Playwright step title and the readback compares lengths only, so appwright never writes it into a step name or an error message. The `webdriver` client's own request log (the `COMMAND` / `DATA` lines at INFO level) still shows what was sent; lower that log level if the report must not carry it at all.

```ts
await device.getById('password').fill(process.env.PASSWORD!, { secret: true });
```

To empty a field without typing, use `clear`; to read what a field currently holds, use `inputValue` (`getText` is empty for an `<input>` in a WebView).

```ts
await device.getByText('Search').clear();
expect(await device.getByText('Search').inputValue()).toBe('');
```

### Pressing a key

To submit a field with the keyboard's Return key, or send a key without clearing the field, use `press`. `Enter` and `Tab` are named keys; anything else is typed character by character. On a native Android field `press` sends real key events, because UiAutomator2's text entry replaces the field's contents (a `"\n"` typed there leaves a single space and submits nothing).

```ts
await device.getByText('Search').fill('Wikipedia');
await device.getByText('Search').press('Enter');
```

### Sending key strokes to an element

To send key strokes to an element, you can use the `sendKeyStrokes` method.

```ts
await device.getByText('Search').sendKeyStrokes('Wikipedia');
```

### Extracting text from an element

To extract text from an element, you can use the `getText` method.

```ts
const text = await device.getByText('Playwright').getText();
```

## Check for visibility of an element

To check if an element is visible on the screen, you can use the `isVisible` method.

```ts
const isVisible = await device.getByText('Playwright').isVisible();
```

To block until an element reaches a state, use `waitFor` with `'attached'`, `'visible'` or `'hidden'`. `'hidden'` is satisfied when nothing matches or the match is not displayed; a stale element is retried rather than counted as gone.

```ts
await device.getByText('Loading…').waitFor('hidden');
```

`expect(locator).not.toBeVisible()` uses the same wait, so it returns as soon as the element is gone rather than after the full timeout.

## Check whether an element is enabled

`isEnabled` waits for the element to be visible, then returns whether it is enabled right now. To wait for the state instead, use `waitFor('enabled')` / `waitFor('disabled')` or the [`toBeEnabled` / `toBeDisabled`](assertions.md#tobeenabled--tobedisabled) assertions. Both states also require the element to be visible.

```ts
const canSubmit = await webView.getByText('Submit').isEnabled();
await webView.getByText('Next').waitFor('enabled');
```

What counts as disabled depends on where the element lives:

- **Native (UiAutomator2 / XCUITest):** the element's WebDriver `enabled` state.
- **WebView:** Playwright's rules. An element that is not a form field (`input`, `textarea`, `select`, contenteditable) is first retargeted to its closest `button`, `[role=button]`, `[role=checkbox]` or `[role=radio]`. This matters because `getByText` resolves to the innermost element holding the text, often a `<span>` inside the `<button>` that carries the state. The target is disabled when it is a natively `:disabled` control (this covers controls inside a disabled `<fieldset>`), or when the nearest `aria-disabled` on it or an ancestor is `"true"`. Unlike Playwright, `aria-disabled` counts whatever the element's role.

## Scroll screen

To scroll the screen, you can use the `scroll` method.

```ts
await device.getByText('Playwright').scroll(ScrollDirection.DOWN);
```

## WebView Locators (Hybrid Apps)

When testing hybrid apps with web content, use the `webView` fixture which provides web-specific locators:

### Get an element by Test ID

The recommended way to select WebView elements is by using the `data-testid` attribute.

```ts
await webView.getByTestId('submit-button').tap();
await webView.getByTestId('username-input').fill('admin');
```

### Get an element by Text

Select elements by their visible text content.

```ts
await webView.getByText('Welcome').tap();
await webView.getByText('Submit', { exact: true }).tap();
```

You can also use RegExp patterns:

```ts
await webView.getByText(/Welcome.*/);
```

### Get an element by CSS Selector

Use CSS selectors for complex queries.

```ts
await webView.css('.login-form input[name="email"]').fill('test@example.com');
await webView.css('#submit-btn').tap();
await webView.css('form > button[type="submit"]').tap();
```

### Get an element by XPath

Use XPath expressions when CSS selectors cannot express the query.

```ts
await webView.getByXpath('//button[@type="submit"]').tap();
await webView.getByXpath('//div[@class="form"]//input[@name="email"]').fill('test@example.com');
```

### Get an element by Placeholder

Select input elements by their placeholder text.

```ts
await webView.getByPlaceholder('Enter your email').fill('test@example.com');
await webView.getByPlaceholder('Search').fill('query');
```

### Get an element by accessibility label

Select elements by their `aria-label`. Defaults to an exact match; set `exact: false` for a substring match.

```ts
await webView.getByLabel('Stations').tap();
await webView.getByLabel('Station', { exact: false }).tap();
```

`fill` on a WebView locator clears the field in a way React notices (through the element's prototype setter plus an `input` event), so a controlled input's `onChange` sees the reset before the typing.

### Execute JavaScript in WebView

Execute JavaScript code directly in the WebView context.

```ts
// Get page title
const title = await webView.evaluate(() => document.title);

// Scroll to bottom
await webView.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

// Get computed style
const color = await webView.evaluate(() => {
  const el = document.querySelector('.header');
  return window.getComputedStyle(el).color;
});
```

**Note:** Currently supports apps with a single WebView only.
