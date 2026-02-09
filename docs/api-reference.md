# API reference

## Device

The device is the core component that allows you to interact with the mobile app. 
It provides methods for interacting with the app, such as tapping, typing, and verifying the state of elements etc.

[API reference](https://empirical-run.github.io/appwright/classes/Device.html) for `Device`

## Locator

Locators are essential for selecting elements in the app. Appwright provides a set of built-in locators that you can use to select elements by text, ID, RegExp or XPath.

[API reference](https://empirical-run.github.io/appwright/interfaces/AppwrightLocator.html) for `Locator`

## WebView

The `webView` fixture provides methods for interacting with WebView content in hybrid mobile applications. It automatically handles context switching between native and web contexts.

### Available Locators

- `webView.getByTestId(testId)` - Select by data-testid attribute (recommended for WebView elements)
- `webView.getByText(text, options?)` - Select by visible text content
- `webView.css(selector)` - Select by CSS selector
- `webView.getByXpath(xpath)` - Select by XPath expression
- `webView.getByPlaceholder(text)` - Select input by placeholder text
- `webView.evaluate(script)` - Execute JavaScript in WebView context

### Usage Example

```ts
test('WebView test', async ({ webView }) => {
  await webView.getByTestId('username').fill('admin');
  await webView.getByText('Login').tap();
  await expect(webView.getByText('Welcome')).toBeVisible();
});
```

### Limitation

Currently supports apps with a **single WebView only**. The framework automatically connects to the first available WebView context within your app.
