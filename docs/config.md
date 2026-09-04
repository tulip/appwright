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

## Running on multiple local devices

Appwright runs one Playwright worker per device: every worker (`parallelIndex` 0, 1, 2, ...) opens
its own Appium session on the device with the same index in the project's `device.devices` list.
This works for both `provider: "local-device"` and `provider: "emulator"`.

Each entry in `devices` has:

- `udid` (required): the device identifier. For Android physical devices this is the adb serial
  (`adb devices`); for Android emulators it is `emulator-<port>` where the port is an even number
  between 5554 and 5584 (the console port range the emulator binary uses); for iOS physical devices
  it is the UDID from `xcrun xctrace list devices`; for iOS simulators it is the simulator UDID from
  `xcrun simctl list devices`.
- `avd` (optional, `emulator` provider, Android only): the AVD name from
  `$ANDROID_HOME/emulator/emulator -list-avds`. Appwright boots this AVD on the port taken from
  `udid` when that emulator is not already running.

A single `udid` on the device config is still accepted and is shorthand for
`devices: [{ udid }]`. Leaving both out keeps the old behaviour of picking the only connected
device, but then only one worker can run.

Rules to keep in mind:

- `workers` must not exceed the number of entries in `devices`. Appwright checks this in global
  setup and fails fast with a message telling you to add devices or lower `workers`, before any
  session is opened.
- The worker slot is Playwright's `parallelIndex`, not `workerIndex`. When Playwright restarts a
  worker after a failure the new worker reuses the same `parallelIndex`, so a retried test runs on
  the same device as the original attempt.
- One Appium server is started per run on a free port (4723 if available, otherwise the next free
  one) and shut down when the run ends. Workers only create and delete sessions on it; Appium is no
  longer restarted after every test. The Appium driver is installed once, and skipped if it is
  already installed.
- Ports that must be unique per concurrent session on one host (`systemPort` on Android;
  `wdaLocalPort`, `mjpegServerPort` and `derivedDataPath` on iOS) are derived from the worker slot
  automatically, so you do not need to set them.
- Emulators and simulators that Appwright booted for the run are shut down at the end. Emulators
  and simulators that were already running when the run started are left alone.
- iOS simulators listed by `udid` are booted with `xcrun simctl` if they are not already booted.

### Example: two Android emulators

```typescript
import { defineConfig, Platform } from "appwright";

export default defineConfig({
  workers: 2,
  projects: [
    {
      name: "android",
      use: {
        platform: Platform.ANDROID,
        device: {
          provider: "emulator",
          devices: [
            { udid: "emulator-5554", avd: "Pixel_7_API_34" },
            { udid: "emulator-5556", avd: "Pixel_7_API_34" },
          ],
        },
        buildPath: "android/app/build/outputs/apk/release/app-release.apk",
      },
    },
  ],
});
```

Worker 0 uses `emulator-5554` and worker 1 uses `emulator-5556`. The same AVD can back several
entries; each one is booted as a separate emulator instance on its own port. The Android emulator
only allows this when all instances of that AVD run with `-read-only`, so Appwright adds the flag
to every instance of a shared AVD (their disk changes are discarded on shutdown). An
entry without `avd` that is not already running boots the first installed AVD, with a warning.

### Example: two iOS physical devices

```typescript
import { defineConfig, Platform } from "appwright";

export default defineConfig({
  workers: 2,
  projects: [
    {
      name: "ios",
      use: {
        platform: Platform.IOS,
        device: {
          provider: "local-device",
          devices: [
            { udid: "00008110-000A1B2C3D4E5F67" },
            { udid: "00008120-001122334455AABB" },
          ],
          updatedWDABundleId: "co.company.WebDriverAgentRunner",
        },
        buildPath: "ios/build/MyApp.ipa",
      },
    },
  ],
});
```

Find the UDIDs with `xcrun xctrace list devices`. Both devices must be connected and trusted before
the run starts; Appwright does not boot or pair physical devices.
