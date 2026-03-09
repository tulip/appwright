# Basics

## Write a Test

In Appwright, writing a test is simple and similar to how tests are written in Playwright, but with enhanced mobile capabilities.

## Configure Projects

In Appwright, you can define multiple test configurations for different platforms (Android, iOS, etc.) within your `appwright.config.ts`. This configuration tells Appwright how to run your tests on different devices and environments.

```ts
// In appwright.config.ts
import { defineConfig, Platform } from "appwright";
export default defineConfig({
  projects: [
    {
      name: "android",
      use: {
        platform: Platform.ANDROID,
        device: {
          provider: "emulator", // or 'local-device' or 'browserstack'
        },
        buildPath: "app-release.apk",
      },
    },
    {
      name: "ios",
      use: {
        platform: Platform.IOS,
        device: {
          provider: "emulator", // or 'local-device' or 'browserstack'
        },
        buildPath: "app-release.app", // Path to your .app file
      },
    },
  ],
});
```

## Built-in Fixtures

Appwright provides built-in fixtures to handle mobile interactions:

### Device Fixture

The `device` fixture offers methods to interact with native mobile app elements.

```ts
import { test, expect } from 'appwright';

test('should display the login screen and tap on Login button', async ({ device }) => {

  // Assert that the login button is visible
  await expect(device.getByText('Login')).toBeVisible();
  
  // Tap on the login button
  await device.getByText('Login').tap();
});
```

### WebView Fixture (Hybrid Apps)

For hybrid mobile apps with WebView content, Appwright provides a `webView` fixture that automatically handles context switching between native and web contexts:

```ts
import { test, expect } from 'appwright';

test('WebView login test', async ({ device, webView }) => {
  // Use webView for web content
  await webView.getByTestId('username').fill('admin');
  await webView.getByTestId('password').fill('password123');
  await webView.getByText('Login').tap();
  
  // Use familiar assertions
  await expect(webView.getByText('Welcome')).toBeVisible();
  
  // Mix device and webView as needed
  await device.backgroundApp(-1);
});
```

**Note:** Currently supports apps with a single WebView only. The framework automatically connects to the first available WebView context within your app.

## Run the Test

To run the test, you can use the `npx appwright test` command.

### Run the test on Android

```sh
npx appwright test --project android
```

### Run the test on iOS

```sh
npx appwright test --project ios
```

Above commands will trigger runs on android and iOS emulators based on the above configuration.

Once the test is completed, the report is launched automatically in the browser.