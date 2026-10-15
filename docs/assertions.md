# Assertions

Appwright provides a set of built-in assertions that you can use to verify the state of your app.

## expect

The `expect` function is used to make assertions on the state of your app.

```ts
const clipboardText = await device.getClipboardText();
expect(clipboardText).toBe("Hello, world!");
```

## toBeVisible

The `toBeVisible` assertion checks if an element is visible on the screen.

```ts
  await expect(device.getByText('Login')).toBeVisible();
```

## toBeEnabled / toBeDisabled

`toBeEnabled` waits for the element to be visible and enabled; `toBeDisabled` waits for it to be visible and disabled. `.not.toBeEnabled()` is the same wait as `toBeDisabled()`, and the other way round. See [locators](locators.md#check-whether-an-element-is-enabled) for what counts as disabled on native elements and in a WebView.

```ts
await expect(webView.getByText('Next')).toBeDisabled();
await webView.getByLabel('Device name').fill('Station 1');
await expect(webView.getByText('Next')).toBeEnabled();
```
