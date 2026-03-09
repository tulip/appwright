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

You can use the `getById` method to select elements by their ID on the screen.

```ts
const element = await device.getById('signup_button');
```

Above method defaults to a substring match, and this can be overridden by setting the `exact` option to `true`.

```ts
const element = await device.getById('signup_button', { exact: true });
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

### Enter text in a text field

To enter text into an element, you can use the `fill` method.

```ts
await device.getByText('Search').fill('Wikipedia');
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
