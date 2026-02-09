# Configuration

Appwright provides a set of configuration options that you can use to customize 
the test environment and thus the behavior of the tests.

## Device Providers

Device providers make Appium compatible mobile devices available to Appwright. These
providers are supported:

- `local-device`
- `emulator`
- `browserstack`
- `lambdatest`

### BrowserStack

BrowserStack [App Automate](https://www.browserstack.com/app-automate) can be used to provide
remote devices to Appwright.

These environment variables are required for the BrowserStack

- BROWSERSTACK_USERNAME
- BROWSERSTACK_ACCESS_KEY

BrowserStack also requires `name` and `osVersion` of the device to be set in the projects in appwright config file.

### LambdaTest

LambdaTest [Real Device Cloud](https://www.lambdatest.com/support/docs/app-testing-on-real-devices/) can be used to provide
remote devices to Appwright.

These environment variables are required for the LambdaTest

- LAMBDATEST_USERNAME
- LAMBDATEST_ACCESS_KEY

LambdaTest also requires `name` and `osVersion` of the device to be set in the projects in appwright config file.

## Local Device & Emulator Configuration

When using `provider: "local-device"` or `provider: "emulator"`, additional configuration options are available for fine-grained control over app behavior and iOS WebDriverAgent settings.

### App Reset Behavior

#### uninstallAppBeforeTest (optional, default: false)

Controls whether the app should be completely uninstalled before starting each test session.

- **`true`**: The app will be fully uninstalled before each session, ensuring a completely clean state
- **`false`**: The app is not uninstalled (existing installation is used)

**Note**: On real devices, app data might be cached under certain circumstances even with this enabled.

#### preserveAppState (optional, default: true)

Controls whether the app state and data should be preserved between test sessions.

- **`true`**: The app continues running and its data is preserved between sessions
- **`false`**: The app is terminated and all its data is cleaned before each session

**Example:**

```typescript
{
  name: "android-fresh-install",
  use: {
    platform: Platform.ANDROID,
    device: {
      provider: "local-device",
      uninstallAppBeforeTest: true,  // Clean install each time
      preserveAppState: false,        // Clear app data
    },
    buildPath: "app-release.apk",
  },
}
```

### iOS WebDriverAgent Configuration

#### updatedWDABundleId (optional, iOS only)

Specifies a custom WebDriverAgent bundle ID to use. This is useful when you've built a custom WebDriverAgent with a different bundle identifier.

**Default**: `com.facebook.WebDriverAgentRunner`

**Example:**

```typescript
{
  name: "ios-custom-wda",
  use: {
    platform: Platform.IOS,
    device: {
      provider: "local-device",
      updatedWDABundleId: "co.tulip.WebDriverAgentRunner",
    },
    buildPath: "MyApp.ipa",
  },
}
```

### Complete Configuration Example

```typescript
import { defineConfig, Platform } from "appwright";

export default defineConfig({
  projects: [
    {
      name: "android-local",
      use: {
        platform: Platform.ANDROID,
        device: {
          provider: "local-device",
          udid: "emulator-5554",  // Optional: specific device
          uninstallAppBeforeTest: false,
          preserveAppState: true,
        },
        buildPath: "android/app/build/outputs/apk/release/app-release.apk",
      },
    },
    {
      name: "ios-local",
      use: {
        platform: Platform.IOS,
        device: {
          provider: "local-device",
          updatedWDABundleId: "co.company.WebDriverAgentRunner",
          uninstallAppBeforeTest: true,
          preserveAppState: false,
        },
        buildPath: "ios/build/MyApp.ipa",
      },
    },
  ],
});
```

### Android Emulator

To run tests on the Android emulator, ensure the following installations are available. If not, follow these steps:

1. **Install Android Studio**: If not installed, download and install it from [here](https://developer.android.com/studio).
2. **Set Android SDK location**: Open Android Studio, copy the Android SDK location, and set the `ANDROID_HOME` environment variable to the same path.
3. **Check Java Installation**: Verify if Java is installed by running `java -version`. If it's not installed:
   - Install Java using Homebrew: `brew install java`.
   - After installation, run the symlink command provided at the end of the installation process.


To check for available emulators, run the following command:

```sh
$ANDROID_HOME/emulator/emulator --list-avds
```

### iOS Simulator

To run tests on the iOS Simulator, ensure the following installations are available. If not, follow these steps:

1. **Install Xcode**: If not installed, download and install it from [here](https://developer.apple.com/xcode/).
2. **Download iOS Simulator**: While installing Xcode, you will be prompted to select the platform to develop for. Ensure that iOS is selected.

To check for available iOS simulators, run the following command:

```sh
xcrun simctl list
```
