import { z } from 'zod';

import { Device } from '../device';

export type ExtractType<T> = T extends z.ZodType ? z.infer<T> : never;

export type ActionOptions = {
  timeout: number;
};

export type FillOptions = Partial<ActionOptions> & {
  /**
   * Treat the value as a secret: the Playwright step title shows `***` instead of the value,
   * and the readback after typing compares lengths rather than contents, so appwright never
   * writes the value into a step name or an error message. The `webdriver` client's own
   * request log is not affected.
   */
  secret?: boolean;
};

export type LabelOptions = {
  /**
   * Defaults to `true`, unlike `getByText()`, which defaults to a substring match. A label is
   * user-facing copy, and "Station Name" would otherwise also match "Station Name Prefix".
   */
  exact?: boolean;
  /**
   * Restrict the match to editable text fields (`EditText` on Android; `TextField`,
   * `SecureTextField` and `TextView` on iOS). A web page rendered natively on iOS repeats one
   * label across the field's wrapper, its `<label>` StaticText and the input itself, and a bare
   * label match can land `fill()` on the StaticText. Ignored by `webView.getByLabel()`.
   */
  editable?: boolean;
};

export type OpenUrlOptions = {
  /**
   * Open the URL in this app (Android package name or iOS bundle id) instead of the platform's
   * default handler. Needed when the app under test itself registers an intent filter / universal
   * link for the URL, which would otherwise catch it.
   */
  app?: string;
};

export type WaitForAppToCloseOptions = {
  timeout?: number;
  pollInterval?: number;
};

export type WaitForFileOptions = {
  timeout?: number;
  pollInterval?: number;
  /**
   * Whether a pulled file is finished, not merely present. A file being written out is
   * progressively non-empty, so presence and length say nothing about whether the writer is
   * done. Defaults to "non-empty".
   */
  isReady?: (contents: Buffer) => boolean;
};

export type AppResetMode = 'reinstall' | 'clearData';

export type CleanDeviceOptions = {
  /**
   * How to reset the app under test before the enclosing block runs.
   *
   * - `'reinstall'` uninstalls and reinstalls the app from the project's `buildPath`, so the
   *   block starts with no stored data, no permissions history and a fresh install.
   * - `'clearData'` keeps the install and wipes the app's data container (`pm clear` on
   *   Android, the simulator's data container on iOS). Much faster than a reinstall when the
   *   build has not changed. iOS simulator only.
   *
   * Defaults to `'reinstall'` when `useCleanDevice()` is called with no options.
   */
  appReset?: AppResetMode;
};

/** The context every native command has to be issued from. */
export const NATIVE_CONTEXT = 'NATIVE_APP';

/** Fixed by the W3C WebDriver spec, despite looking generated. */
export const ELEMENT_REFERENCE_ID = 'element-6066-11e4-a52e-4f735466cecf' as const;

export type TimeoutOptions = {
  /**
   * The maximum amount of time (in milliseconds) to wait for the condition to be met.
   */
  expectTimeout: number;
};

export interface DeviceProvider {
  /**
   * Identifier for the Appium session. Can be undefined if the session was not created.
   */
  sessionId?: string;

  /**
   * Global setup validates the configuration and prepares devices.
   *
   * @param options.workers number of Playwright workers for this run; providers may use it to
   * decide how many configured devices to prepare (e.g. how many emulators to boot).
   */
  globalSetup?(options?: { workers: number }): Promise<void>;

  /**
   * Returns a device instance.
   */
  getDevice(): Promise<Device>;

  /**
   * Updates test details and test status.
   *
   * @param status of the test
   * @param reason for the test status
   * @param name of the test
   */
  syncTestDetails?: (details: { status?: string; reason?: string; name?: string }) => Promise<void>;
}

export type AppwrightConfig = {
  platform: Platform;
  device: DeviceConfig;
  buildPath: string;
  appBundleId: string;
  // TODO: use expect timeout from playwright config
  expectTimeout: number;
};

export type DeviceConfig =
  | BrowserStackConfig
  | LambdaTestConfig
  | LocalDeviceConfig
  | EmulatorConfig;

/**
 * One physical device, emulator or simulator that a project can drive.
 *
 * Devices are assigned to Playwright workers by position: worker slot `n`
 * (Playwright's `parallelIndex`) always uses `devices[n]`.
 */
export type DeviceEntry = {
  /**
   * Unique device identifier.
   * - Android physical device: adb serial (see `adb devices`)
   * - Android emulator: `emulator-<port>` with an even port in 5554..5584
   * - iOS physical device: UDID (see `xcrun xctrace list devices`)
   * - iOS simulator: simulator UDID (see `xcrun simctl list devices`)
   */
  udid: string;

  /**
   * **Emulator provider, Android only**: name of the AVD to boot when `udid` is not online
   * when the run starts (see `emulator -list-avds`). Emulators booted by Appwright are shut down
   * at the end of the run; emulators that were already running are left alone.
   */
  avd?: string;
};

/**
 * Configuration options for app reset behavior between test sessions.
 */
export type AppResetConfig = {
  /**
   * Whether to completely uninstall the app before starting a new test session.
   * When set to `true`, the application under test will be fully uninstalled before each session starts,
   * ensuring a completely clean state. Note that app data might be cached on real devices under particular circumstances.
   *
   * @default false - App is not uninstalled between sessions
   */
  uninstallAppBeforeTest?: boolean;

  /**
   * Whether to preserve the application state between test sessions.
   * When set to `true`, the app is not terminated and its data is not cleaned between sessions,
   * allowing tests to continue from the previous state.
   * When set to `false`, the app is terminated and all its data is cleaned before each session.
   *
   * @default true - App state is preserved between sessions
   */
  preserveAppState?: boolean;
};

/**
 * Configuration for devices running on Browserstack.
 */
export type BrowserStackConfig = {
  provider: 'browserstack';

  /**
   * The name of the device to be used on Browserstack.
   * Checkout the list of devices supported by BrowserStack: https://www.browserstack.com/list-of-browsers-and-platforms/app_automate
   * Example: "iPhone 15 Pro Max", "Samsung Galaxy S23 Ultra".
   */
  name: string;

  /**
   * The operating system version of the device to be used on Browserstack.
   * Checkout the list of OS versions supported by BrowserStack: https://www.browserstack.com/list-of-browsers-and-platforms/app_automate
   * Example: "14.0", "15.0".
   */
  osVersion: string;

  /**
   * The orientation of the device on Browserstack.
   * Default orientation is "portrait".
   */
  orientation?: DeviceOrientation;

  /**
   * Whether to enable camera injection on the device.
   * Default is false.
   */
  enableCameraImageInjection?: boolean;
};

export type LambdaTestConfig = {
  provider: 'lambdatest';

  /**
   * The name of the device to be used on LambdaTest.
   * Checkout the list of devices supported by LambdaTest: https://www.lambdatest.com/list-of-real-devices
   * Example: "iPhone 15 Pro Max", "Galaxy S23 Ultra".
   */
  name: string;

  /**
   * The operating system version of the device to be used on LambdaTest.
   * Checkout the list of OS versions supported by LambdaTest: https://www.lambdatest.com/list-of-real-devices
   * Example: "14.0", "15.0".
   */
  osVersion: string;

  /**
   * The orientation of the device on LambdaTest.
   * Default orientation is "portrait".
   */
  orientation?: DeviceOrientation;

  /**
   * Whether to enable camera injection on the device.
   * Default is false.
   */
  enableCameraImageInjection?: boolean;
};

/**
 * Configuration for locally connected physical devices.
 */
export type LocalDeviceConfig = {
  provider: 'local-device';
  name?: string;

  /**
   * The unique device identifier (UDID) of the connected local device.
   * Shorthand for `devices: [{ udid }]`.
   */
  udid?: string;

  /**
   * Devices available to this project, one per Playwright worker. Worker slot `n`
   * (`parallelIndex`) uses `devices[n]`. `workers` in the config must not exceed the
   * number of entries.
   */
  devices?: DeviceEntry[];

  /**
   * The orientation of the device.
   * Default orientation is "portrait".
   */
  orientation?: DeviceOrientation;

  /**
   * **iOS only**: Custom WDA (WebDriverAgent) bundle ID to use.
   *
   * This is useful when using a custom-built WebDriverAgent with a different bundle identifier. Defaults to "com.facebook.WebDriverAgentRunner" if not specified.
   * This property is only applicable when `platform` is set to `Platform.IOS` and will be ignored on Android.
   *
   * @example
   * ```typescript
   * device: {
   *   provider: 'local-device',
   *   updatedWDABundleId: 'co.tulip.WebDriverAgentRunner'
   * }
   * ```
   */
  updatedWDABundleId?: string;
} & AppResetConfig;

/**
 * Configuration for running tests on an Android or iOS emulator.
 */
export type EmulatorConfig = {
  provider: 'emulator';
  name?: string;
  osVersion?: string;

  /**
   * The unique device identifier (UDID) of the emulator.
   * Shorthand for `devices: [{ udid }]`.
   */
  udid?: string;

  /**
   * Emulators/simulators available to this project, one per Playwright worker. Worker slot `n`
   * (`parallelIndex`) uses `devices[n]`. Android entries may carry an `avd` name so Appwright can
   * boot the emulator when it is not already running. `workers` in the config must not exceed the
   * number of entries.
   */
  devices?: DeviceEntry[];

  /**
   * The orientation of the emulator.
   * Default orientation is "portrait".
   */
  orientation?: DeviceOrientation;
} & AppResetConfig;

export enum Platform {
  ANDROID = 'android',
  IOS = 'ios',
}

export enum DeviceOrientation {
  PORTRAIT = 'portrait',
  LANDSCAPE = 'landscape',
}

export enum ScrollDirection {
  UP = 'up',
  DOWN = 'down',
}

export interface AppwrightLocator {
  /**
   * Taps (clicks) on the element. This method waits for the element to be visible before clicking it.
   *
   * **Usage:**
   * ```js
   * await device.getByText("Submit").tap();
   * ```
   *
   * @param options Use this to override the timeout for this action
   */
  tap(options?: ActionOptions): Promise<void>;

  /**
   * Fills the input element with the given value. This method waits for the element to be visible before filling it.
   *
   * **Usage:**
   * ```js
   * await device.getByText("Search").fill("My query");
   * ```
   *
   * @param value The value to fill in the input field
   * @param options Use this to override the timeout for this action
   */
  fill(value: string, options?: FillOptions): Promise<void>;

  /**
   * Empties the input element. Waits for the element to be visible first.
   *
   * In a WebView the value is reset through the element's prototype setter and an `input`
   * event, so a React controlled input's owner sees the change; WebDriver's own clear fires
   * only `change`, which React ignores.
   *
   * **Usage:**
   * ```js
   * await device.getByLabel("Search").clear();
   * ```
   */
  clear(options?: ActionOptions): Promise<void>;

  /**
   * Presses a key in the element without clearing it. `"Enter"` and `"Tab"` are named keys;
   * anything else is typed character by character. This is the way to submit a field with the
   * keyboard's Return key.
   *
   * On a native Android field this sends real key events (after a tap to focus the field),
   * because UiAutomator2's text entry replaces the field's contents. On iOS and in a WebView the
   * key is typed into the element.
   *
   * **Usage:**
   * ```js
   * await device.getByLabel("Account URL").press("Enter");
   * ```
   */
  press(key: string, options?: ActionOptions): Promise<void>;

  /**
   * Returns the current value of an input element. `getText()` is empty for an `<input>` in a
   * WebView, and native text fields report their contents through an attribute rather than
   * the element text on some drivers, so this is the reliable readback.
   *
   * **Usage:**
   * ```js
   * expect(await webView.css("#url").inputValue()).toBe("https://example.com");
   * ```
   */
  inputValue(options?: ActionOptions): Promise<string>;

  /**
   * Sends key strokes to the element. This method waits for the element to be visible before sending the key strokes.
   *
   * **Usage:**
   * ```js
   * await device.getByText("Search").sendKeyStrokes("My query");
   * ```
   *
   * @param value The string to send as key strokes.
   * @param options Use this to override the timeout for this action
   */
  sendKeyStrokes(value: string, options?: ActionOptions): Promise<void>;

  /**
   * Wait for the element to be attached, visible or hidden, while attempting for the `timeout`
   * duration. Throws TimeoutError if the state is not reached within the timeout.
   *
   * `'hidden'` is satisfied when no element matches or the match is not displayed. A stale
   * element reference is retried rather than read as hidden, so a node that is being re-rendered
   * does not count as gone.
   *
   * **Usage:**
   * ```js
   * await device.getByText("Search").waitFor("visible");
   * await device.getByText("Loading…").waitFor("hidden");
   * ```
   *
   * @param state The state to wait for
   * @param options Use this to override the timeout for this action
   */
  waitFor(state: 'attached' | 'visible' | 'hidden', options?: ActionOptions): Promise<void>;

  /**
   * Waits for the element to be visible, while attempting for the `timeout` duration.
   * Returns boolean based on the visibility of the element.
   *
   * **Usage:**
   * ```js
   * const isVisible = await device.getByText("Search").isVisible();
   * ```
   *
   * @param options Use this to override the timeout for this action
   */
  isVisible(options?: ActionOptions): Promise<boolean>;

  /**
   * Returns the text content of the element. This method waits for the element to be visible before getting the text.
   *
   * **Usage:**
   * ```js
   * const textContent = await device.getByText("Search").getText();
   * ```
   *
   * @param options Use this to override the timeout for this action
   */
  getText(options?: ActionOptions): Promise<string>;

  scroll(direction: ScrollDirection): Promise<void>;

  /**
   * Resolves the WebDriver element reference behind this locator, or `null` when nothing
   * matches right now. Does not wait. Use it to hand the element to a raw command that the
   * locator does not wrap.
   */
  getElement(): Promise<ElementReference | null>;
}

export enum WebDriverErrors {
  StaleElementReferenceError = 'stale element reference',
}

export type ElementReferenceId = typeof ELEMENT_REFERENCE_ID;
export type ElementReference = Record<ElementReferenceId, string>;
