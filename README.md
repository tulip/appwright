# @tulip/appwright

> **Note**: This is a fork of [empirical-run/appwright](https://github.com/empirical-run/appwright) maintained by Tulip with additional features including support for hybrid apps and enhanced configuration for local devices and emulators.

Appwright is a test framework for e2e testing of mobile apps. Appwright builds on top of [Appium](https://appium.io/docs/en/latest/), and can
run tests on local devices, emulators, and remote device farms — for both iOS and Android.

Appwright is one integrated package that combines an automation driver, test runner and test
reporter. To achieve this, Appwright uses the [Playwright](https://github.com/microsoft/playwright) test runner internally, which is
purpose-built for the e2e testing workflow.

Appwright exposes an ergonomic API to automate user actions. These actions auto-wait and auto-retry
for UI elements to be ready and interactable, which makes your tests easier to read and maintain.

```ts
import { test, expect } from 'appwright';

test('User can login', async ({ device }) => {
  await device.getByText('Username').fill('admin');
  await device.getByText('Password').fill('password');
  await device.getByText('Login').tap();
});
```

Links to help you get started.

- [Example project](https://github.com/empirical-run/appwright/tree/main/example)
- [Launch blog post](https://www.empirical.run/blog/appwright)
- [Documentation](#docs)

## Hybrid App Testing (WebView Support)

This fork adds support for testing **hybrid mobile applications** that contain WebView content. The `webView` fixture automatically handles context switching between native and WebView contexts.

**Example:**

```ts
import { test, expect } from 'appwright';

test('WebView login test', async ({ device, webView }) => {
  // Automatically switches to WebView context
  await webView.getByTestId('username').fill('admin');
  await webView.getByTestId('password').fill('password123');
  await webView.getByText('Login').tap();

  // Use familiar assertions
  await expect(webView.getByText('Welcome')).toBeVisible();

  await device.backgroundApp(-1);
});
```

### Supported Locators

- `webView.getByTestId()` - Recommended for WebView elements
- `webView.getByText()` - Find by visible text
- `webView.css()` - CSS selectors
- `webView.getByXpath()` - XPath expressions
- `webView.getByPlaceholder()` - Input placeholder text
- `webView.evaluate()` - Execute JavaScript in WebView context

### Limitation

Currently supports apps with a **single WebView only**. The framework automatically connects to the first available WebView context within your app.

## Usage

### Minimum requirements

- Node 20.19.0 (with the semver range ^20.19.0 || ^22.12.0 || >=24.0.0), as well as the minimum npm version to 10

### Install

```sh
npm i --save-dev appwright
touch appwright.config.ts
```

### Configure

```ts
// In appwright.config.ts
import { defineConfig, Platform } from 'appwright';
export default defineConfig({
  projects: [
    {
      name: 'android',
      use: {
        platform: Platform.ANDROID,
        device: {
          provider: 'emulator', // or 'local-device' or 'browserstack'
        },
        buildPath: 'app-release.apk',
      },
    },
    {
      name: 'ios',
      use: {
        platform: Platform.IOS,
        device: {
          provider: 'emulator', // or 'local-device' or 'browserstack'
        },
        buildPath: 'app-release.app', // Path to your .app file
      },
    },
  ],
});
```

### Configuration Options

- `platform`: The platform you want to test on, such as 'android' or 'ios'.

- `provider`: The device provider where you want to run your tests.
  You can choose between `browserstack`, `lambdatest`, `emulator`, or `local-device`.

- `buildPath`: The path to your build file. For Android, it should be an APK file.
  For iOS, if you are running tests on real device, it should be an `.ipa` file. For running tests on an emulator, it should be a `.app` file.

#### Local Device & Emulator Specific Options

When using `provider: "local-device"` or `provider: "emulator"`, additional configuration options are available:

- `uninstallAppBeforeTest` _(optional, default: false)_: Set to `true` to completely uninstall the app before starting each test session, ensuring a clean state.

- `preserveAppState` _(optional, default: true)_: Set to `true` to keep the app running and preserve its data between test sessions. Set to `false` to terminate the app and clear its data before each session.

- `updatedWDABundleId` _(optional, iOS only)_: Custom WebDriverAgent bundle ID for iOS local devices. Use this when running a custom-built WebDriverAgent (e.g., 'co.tulip.WebDriverAgentRunner').

See [Configuration](docs/config.md) for detailed documentation and examples.

### Run tests

To run tests, you need to specify the project name with `--project` flag.

```sh
npx appwright test --project android
npx appwright test --project ios
```

To run on several local devices or emulators at once, list them under `device.devices` in the
project config and raise `workers` up to that number; each Playwright worker then drives its own
device. See [Running on multiple local devices](docs/config.md#running-on-multiple-local-devices).

#### Run tests on BrowserStack

Appwright supports BrowserStack out of the box. To run tests on BrowserStack, configure
the provider in your config.

```ts
{
  name: "android",
  use: {
    platform: Platform.ANDROID,
    device: {
      provider: "browserstack",
      // Specify device to run the tests on
      // See supported devices: https://www.browserstack.com/list-of-browsers-and-platforms/app_automate
      name: "Google Pixel 8",
      osVersion: "14.0",
    },
    buildPath: "app-release.apk",
  },
},
```

#### Run tests on LambdaTest

Appwright supports LambdaTest out of the box. To run tests on LambdaTest, configure
the provider in your config.

```ts
{
  name: "android",
  use: {
    platform: Platform.ANDROID,
    device: {
      provider: "lambdatest",
      // Specify device to run the tests on
      // See supported devices: https://www.lambdatest.com/list-of-real-devices
      name: "Pixel 8",
      osVersion: "14",
    },
    buildPath: "app-release.apk",
  },
},
```

## Run the sample project

To run the sample project:

- Navigate to the `example` directory.

```sh
cd example
```

- Install dependencies.

```sh
npm install
```

- Run the tests

Run the following command to execute tests on an Android emulator:

```sh
npx appwright test --project android
```

To run the tests on iOS simulator:

- Unzip the `wikipedia.zip` file

```sh
npm run extract:app
```

- Run the following command:

```sh
npx appwright test --project ios
```

## Docs

- [Basics](docs/basics.md)
- [Configuration](docs/config.md)
- [Locators](docs/locators.md)
- [Assertions](docs/assertions.md)
- [API reference](docs/api-reference.md)
