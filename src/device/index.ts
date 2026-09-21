import path from 'path';
import type { Client as WebDriverClient } from 'webdriver';
import { z } from 'zod';

import { LLMModel } from '@empiricalrun/llm';

import { Locator } from '../locator';
import { logger } from '../logger';
import { uploadImageToBS } from '../providers/browserstack/utils';
import { uploadImageToLambdaTest } from '../providers/lambdatest/utils';
import {
  AppwrightLocator,
  ExtractType,
  LabelOptions,
  NATIVE_CONTEXT,
  OpenUrlOptions,
  Platform,
  TimeoutOptions,
  WaitForAppToCloseOptions,
  WaitForFileOptions,
} from '../types';
import { boxedStep, delay, escapeQuotes, escapeRegExp, longestDeterministicGroup } from '../utils';
import { AppwrightVision, VisionProvider } from '../vision';

/** Providers whose devices are in a cloud: a local build file cannot be installed on them. */
const CLOUD_PROVIDERS = ['browserstack', 'lambdatest'];

/** Only this provider keeps an iOS app's data container where `mobile: clearApp` can reach it. */
const IOS_SIMULATOR_PROVIDER = 'emulator';

/** Public, so a pull from here needs no `run-as`. */
const ANDROID_DOWNLOADS_DIR = '/sdcard/Download';

const IOS_EDITABLE_TYPES = [
  'XCUIElementTypeTextField',
  'XCUIElementTypeSecureTextField',
  'XCUIElementTypeTextView',
];

function trimLeadingSlashes(relativePath: string): string {
  return relativePath.replace(/^\/+/, '');
}

export class Device {
  constructor(
    private webDriverClient: WebDriverClient,
    /** The app under test, read off the build. Not the foreground app. */
    private bundleId: string | undefined,
    private timeoutOpts: TimeoutOptions,
    private provider: string,
    /** The project's `buildPath`, so `reinstallApp()` needs no argument. */
    private buildPath?: string,
  ) {}

  /**
   * Creates a locator without any context switching. Use locator() method instead for
   * automatic context switching.
   * @internal
   */
  createLocator({
    selector,
    findStrategy,
    textToMatch,
    web = false,
  }: {
    selector: string;
    findStrategy: string;
    textToMatch?: string | RegExp;
    /** Set by `WebView`: the locator resolves in a WEBVIEW context and edits through the DOM. */
    web?: boolean;
  }): AppwrightLocator {
    return new Locator(
      this.webDriverClient,
      this.timeoutOpts,
      selector,
      findStrategy,
      textToMatch,
      web,
    );
  }

  /**
   * Ensures we're in NATIVE_APP context before any operation
   */
  private async ensureNativeContext(): Promise<void> {
    const currentContext = await this.getCurrentContext();
    console.log('[Device] Current context:', currentContext);
    if (currentContext !== NATIVE_CONTEXT) {
      console.log('[Device] Switching to NATIVE_APP context');
      await this.switchToNativeContext();
    }
  }

  /**
   * Wraps a locator to automatically switch to native context before any action
   */
  private wrapWithNativeContext(locator: AppwrightLocator): AppwrightLocator {
    const self = this;
    return new Proxy(locator, {
      get(target, prop) {
        const original = target[prop as keyof AppwrightLocator];

        // Wrap all async methods (actions that interact with elements)
        if (typeof original === 'function' && prop !== 'constructor') {
          return async function (...args: any[]) {
            await self.ensureNativeContext();
            return await (original as Function).apply(target, args);
          };
        }

        return original;
      },
    });
  }

  locator({
    selector,
    findStrategy,
    textToMatch,
  }: {
    selector: string;
    findStrategy: string;
    textToMatch?: string | RegExp;
  }): AppwrightLocator {
    const originalLocator = this.createLocator({
      selector,
      findStrategy,
      textToMatch,
    });
    return this.wrapWithNativeContext(originalLocator);
  }

  private vision(): AppwrightVision {
    return new VisionProvider(this, this.webDriverClient);
  }

  beta = {
    tap: async (
      prompt: string,
      options?: {
        useCache?: boolean;
        telemetry?: {
          tags?: string[];
        };
      },
    ): Promise<{ x: number; y: number }> => {
      return await this.vision().tap(prompt, options);
    },

    query: async <T extends z.ZodType>(
      prompt: string,
      options?: {
        responseFormat?: T;
        model?: LLMModel;
        screenshot?: string;
        telemetry?: {
          tags?: string[];
        };
      },
    ): Promise<ExtractType<T>> => {
      return await this.vision().query(prompt, options);
    },
  };

  /**
   * Closes the automation session. This is called automatically after each test.
   *
   * **Usage:**
   * ```js
   * await device.close();
   * ```
   */
  async close() {
    // TODO: Add @boxedStep decorator here
    // Disabled because it breaks persistentDevice as test.step will throw as test is
    // undefined when the function is called
    try {
      await this.webDriverClient.deleteSession();
    } catch (e) {
      logger.error(`close:`, e);
    }
  }

  /**
   * Tap on the screen at the given coordinates, specified as x and y. The top left corner
   * of the screen is { x: 0, y: 0 }.
   *
   * **Usage:**
   * ```js
   * await device.tap({ x: 100, y: 100 });
   * ```
   *
   * @param coordinates to tap on
   * @returns
   */
  @boxedStep
  async tap({ x, y }: { x: number; y: number }) {
    if (this.getPlatform() == Platform.ANDROID) {
      await this.webDriverClient.executeScript('mobile: clickGesture', [
        {
          x: x,
          y: y,
          duration: 100,
          tapCount: 1,
        },
      ]);
    } else {
      await this.webDriverClient.executeScript('mobile: tap', [
        {
          x: x,
          y: y,
        },
      ]);
    }
  }

  /**
   * Locate an element on the screen with text content. This method defaults to a
   * substring match, and this be overridden by setting the `exact` option to `true`.
   *
   * **Usage:**
   * ```js
   * // with string
   * const submitButton = device.getByText("Submit");
   *
   * // with RegExp
   * const counter = device.getByText(/^Counter: \d+/);
   * ```
   *
   * @param text string or regular expression to search for
   * @param options
   * @returns
   */
  getByText(text: string | RegExp, { exact = false }: { exact?: boolean } = {}): AppwrightLocator {
    const isAndroid = this.getPlatform() == Platform.ANDROID;
    if (text instanceof RegExp) {
      const substringForContains = longestDeterministicGroup(text);
      if (!substringForContains) {
        return this.locator({
          selector: '//*',
          findStrategy: 'xpath',
          textToMatch: text,
        });
      } else {
        const selector = isAndroid
          ? `textContains("${substringForContains}")`
          : `label CONTAINS "${substringForContains}"`;
        return this.locator({
          selector: selector,
          findStrategy: isAndroid ? '-android uiautomator' : '-ios predicate string',
          textToMatch: text,
        });
      }
    }
    const quoted = escapeQuotes(text);
    let selector: string;
    if (isAndroid) {
      selector = exact ? `text("${quoted}")` : `textContains("${quoted}")`;
    } else {
      selector = exact ? `label == "${quoted}"` : `label CONTAINS "${quoted}"`;
    }
    return this.locator({
      selector,
      findStrategy: isAndroid ? '-android uiautomator' : '-ios predicate string',
      textToMatch: text,
    });
  }

  /**
   * Locate an element on the screen with accessibility identifier (`resource-id` on Android,
   * `name` on iOS). Defaults to an exact match; set `exact: false` for a substring match.
   *
   * **Usage:**
   * ```js
   * const element = await device.getById("signup_button");
   * ```
   *
   * @param text string to search for
   * @param options
   * @returns
   */
  getById(text: string, { exact = true }: { exact?: boolean } = {}): AppwrightLocator {
    const isAndroid = this.getPlatform() == Platform.ANDROID;
    let selector: string;
    if (isAndroid) {
      // `resourceIdMatches` takes a regular expression, so the id is escaped to match literally.
      selector = exact
        ? `resourceId("${escapeQuotes(text)}")`
        : `resourceIdMatches("${escapeQuotes(`.*${escapeRegExp(text)}.*`)}")`;
    } else {
      const quoted = escapeQuotes(text);
      selector = exact ? `name == "${quoted}"` : `name CONTAINS "${quoted}"`;
    }
    return this.locator({
      selector,
      findStrategy: isAndroid ? '-android uiautomator' : '-ios predicate string',
      textToMatch: text,
    });
  }

  /**
   * Locate an element by its accessibility label: `content-desc` on Android, `label` on iOS.
   * React Native's `accessibilityLabel` lands here on both platforms. Neither `getByText()`
   * (which reads `text` on Android) nor `getById()` (`resource-id`) can find a label-only element.
   *
   * Defaults to an exact match. Pass `editable: true` to restrict the match to text fields —
   * on iOS a natively rendered web page repeats one label across the field's wrapper, its
   * StaticText and the input itself, and a bare label match can land `fill()` on the StaticText.
   *
   * Prefer a `testID` (`getById()`) where the app exposes one: a label is user-facing copy and
   * moves with wording and i18n changes.
   *
   * **Usage:**
   * ```js
   * await device.getByLabel("Station Name", { editable: true }).fill("Line 1");
   * await expect(device.getByLabel("Settings")).toBeVisible();
   * ```
   */
  getByLabel(
    label: string,
    { exact = true, editable = false }: LabelOptions = {},
  ): AppwrightLocator {
    const quoted = escapeQuotes(label);
    if (this.getPlatform() == Platform.ANDROID) {
      const method = exact ? 'description' : 'descriptionContains';
      const className = editable ? '.classNameMatches(".*EditText")' : '';
      return this.locator({
        selector: `new UiSelector().${method}("${quoted}")${className}`,
        findStrategy: '-android uiautomator',
      });
    }
    const typeFilter = editable
      ? ` AND type IN {${IOS_EDITABLE_TYPES.map((type) => `"${type}"`).join(', ')}}`
      : '';
    return this.locator({
      selector: `label ${exact ? '==' : 'CONTAINS'} "${quoted}"${typeFilter}`,
      findStrategy: '-ios predicate string',
    });
  }

  /**
   * Locate an element on the screen with xpath.
   *
   * **Usage:**
   * ```js
   * const element = await device.getByXpath(`//android.widget.Button[@text="Confirm"]`);
   * ```
   *
   * @param xpath xpath to locate the element
   * @returns
   */
  getByXpath(xpath: string): AppwrightLocator {
    return this.locator({ selector: xpath, findStrategy: 'xpath' });
  }

  /**
   * Helper method to detect the mobile OS running on the device.
   *
   * **Usage:**
   * ```js
   * const platform = device.getPlatform();
   * ```
   *
   * @returns "android" or "ios"
   */
  getPlatform(): Platform {
    const isAndroid = this.webDriverClient.isAndroid;
    return isAndroid ? Platform.ANDROID : Platform.IOS;
  }

  /**
   * The app currently in the foreground — a browser, a system dialog, or the app under test.
   * For the app under test itself, use `getAppBundleId()`.
   *
   * Leaves the session in the NATIVE_APP context: `mobile: getCurrentPackage` is a native
   * command, and Appium routes it to chromedriver from a WEBVIEW context, where it fails.
   */
  async getCurrentBundleId(): Promise<string> {
    await this.ensureNativeContext();
    if (this.getPlatform() == Platform.ANDROID) {
      return await this.webDriverClient.executeScript('mobile: getCurrentPackage', []);
    }
    const { bundleId } = await this.webDriverClient.executeScript('mobile: activeAppInfo', []);
    return bundleId;
  }

  /**
   * The bundle id (iOS) or package name (Android) of the app under test, read off the build.
   * Unlike `getCurrentBundleId()`, this does not change when another app comes to the front.
   *
   * Throws when the provider could not determine it: the emulator and local-device providers
   * read a real one off the build, BrowserStack reports the uploaded app's name instead.
   */
  getAppBundleId(): string {
    if (!this.bundleId) {
      throw new Error(
        'The device has no bundle id for the app under test. The emulator and local-device ' +
          "providers read a real one off the build; BrowserStack reports the uploaded app's name " +
          'instead, and an empty string when it has none.',
      );
    }
    return this.bundleId;
  }

  /**
   * The appwright project's `provider`, e.g. `emulator`, `local-device`, `browserstack`. A
   * simulator and a USB phone both report `Platform.IOS`; only this separates them.
   */
  getProvider(): string {
    return this.provider;
  }

  /**
   * Runs an Appium `mobile:` extension command that appwright does not wrap. Prefer the typed
   * methods where one exists — they hide the per-driver argument names (`appId` on Android,
   * `bundleId` on iOS).
   *
   * **Usage:**
   * ```js
   * await device.executeMobileCommand('mobile: shell', { command: 'ls', args: ['/sdcard'] });
   * ```
   */
  async executeMobileCommand<T = unknown>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    return (await this.webDriverClient.executeScript(command, [args])) as T;
  }

  /** The argument name each driver uses for an application id in `mobile:` commands. */
  private appIdArg(appId: string): Record<string, string> {
    return this.getPlatform() == Platform.ANDROID ? { appId } : { bundleId: appId };
  }

  private isIosSimulator(): boolean {
    return this.getPlatform() == Platform.IOS && this.provider === IOS_SIMULATOR_PROVIDER;
  }

  /**
   * Whether `appId` is installed on the device.
   */
  async isAppInstalled(appId: string): Promise<boolean> {
    return await this.webDriverClient.isAppInstalled(appId);
  }

  /**
   * Wipes an app's data without uninstalling it: `pm clear` on Android, the data container on an
   * iOS simulator. Defaults to the app under test.
   *
   * On Android, `pm clear` also revokes the app's runtime permissions; `resetAppData()` grants
   * them back. iOS real devices have no reachable data container — use `reinstallApp()` there.
   */
  @boxedStep
  async clearAppData(appId: string = this.getAppBundleId()): Promise<void> {
    if (this.getPlatform() == Platform.IOS && !this.isIosSimulator()) {
      throw new Error(
        `Cannot clear the data of '${appId}' on a '${this.provider}' iOS device: only a ` +
          'simulator exposes an app data container. Use reinstallApp() instead.',
      );
    }
    await this.executeMobileCommand('mobile: clearApp', this.appIdArg(appId));
  }

  /**
   * [Android] Grants every runtime permission `appId` declares. Restores what
   * `appium:autoGrantPermissions` gave the app before a `pm clear` revoked it. A no-op on iOS,
   * where permissions cannot be granted from outside the app.
   */
  @boxedStep
  async grantAllPermissions(appId: string = this.getAppBundleId()): Promise<void> {
    if (this.getPlatform() != Platform.ANDROID) {
      logger.log(`grantAllPermissions: nothing to do on iOS for ${appId}.`);
      return;
    }
    await this.executeMobileCommand('mobile: changePermissions', {
      appPackage: appId,
      permissions: 'all',
      action: 'grant',
    });
  }

  /**
   * Uninstalls and reinstalls the app under test from the build, then brings it back to the
   * foreground. Identical on both platforms, and usable mid-session — unlike
   * `appium:fullReset`, which only applies at session creation and means "reinstall" on
   * Android but "erase the simulator" on iOS.
   *
   * On Android the reinstall grants the app's runtime permissions, matching the
   * `appium:autoGrantPermissions` the session was created with; a plain install would leave
   * the next test facing a permission prompt.
   *
   * **Usage:**
   * ```js
   * test.beforeAll(async ({ device }) => {
   *   await device.reinstallApp();
   * });
   * ```
   *
   * @param buildPath Defaults to the project's `buildPath`. Relative paths are resolved against
   * the current working directory, not Appium's.
   */
  @boxedStep
  async reinstallApp(buildPath: string | undefined = this.buildPath): Promise<void> {
    if (CLOUD_PROVIDERS.includes(this.provider)) {
      throw new Error(
        `reinstallApp() is not supported on the '${this.provider}' provider: a local build ` +
          'file cannot be installed on a cloud device. Configure the reset through the ' +
          "provider's session capabilities instead.",
      );
    }
    if (!buildPath) {
      throw new Error(
        'reinstallApp() needs a build path: none was given and the project has no `buildPath`.',
      );
    }

    const appId = this.getAppBundleId();
    const appPath = path.resolve(buildPath);

    await this.terminateApp(appId);
    await this.webDriverClient.removeApp(appId);
    if (this.getPlatform() == Platform.ANDROID) {
      await this.executeMobileCommand('mobile: installApp', { appPath, grantPermissions: true });
    } else {
      await this.webDriverClient.installApp(appPath);
    }
    // activateApp() switches back to NATIVE_APP: WEBVIEW context ids do not survive a reinstall.
    await this.activateApp(appId);

    logger.log(`Reinstalled ${appId} from ${appPath}.`);
  }

  /**
   * Resets the app under test to a first-launch state without reinstalling it: terminate, wipe
   * its data, grant its permissions back (Android), relaunch. Much faster than `reinstallApp()`
   * when the build has not changed. iOS simulator only.
   */
  @boxedStep
  async resetAppData(): Promise<void> {
    const appId = this.getAppBundleId();
    await this.terminateApp(appId);
    await this.clearAppData(appId);
    await this.grantAllPermissions(appId);
    await this.activateApp(appId);
    logger.log(`Reset the data of ${appId}.`);
  }

  /**
   * Opens `url` the way a person tapping a link outside the app would: with the platform's
   * default handler unless `app` names one. Returns the bundle id / package of the app that came
   * to the foreground, so the caller can wait on exactly that app:
   *
   * ```js
   * const browser = await device.openUrl(`${site}/login`);
   * // …drive the browser via device.getByText(...)
   * await device.waitForAppToClose(browser);
   * await device.activateApp();
   * ```
   *
   * The Appium session stays in the NATIVE_APP context, so locators resolve against the browser
   * from here on. `webDriverClient.navigateTo()` is not the same thing: uiautomator2's `setUrl`
   * passes the app under test as the intent's package, which deep-links *into* the app rather
   * than out to a browser.
   */
  @boxedStep
  async openUrl(url: string, { app }: OpenUrlOptions = {}): Promise<string> {
    const target =
      app == null
        ? {}
        : this.getPlatform() == Platform.ANDROID
        ? { package: app }
        : { bundleId: app };
    const before = this.bundleId;

    await this.executeMobileCommand('mobile: deepLink', { url, ...target });

    // Whatever handled the URL takes a moment to reach the foreground.
    const deadline = Date.now() + this.timeoutOpts.expectTimeout;
    let foreground = await this.getCurrentBundleId();
    while (foreground === before && Date.now() < deadline) {
      await delay(500);
      foreground = await this.getCurrentBundleId();
    }

    logger.log(`Opened ${url} in ${foreground}.`);
    return foreground;
  }

  /**
   * Blocks until `appId` is no longer the foreground app — a browser closing itself once an
   * auth flow redirects back to the app, a system dialog being dismissed.
   */
  @boxedStep
  async waitForAppToClose(
    appId: string,
    { timeout = 60_000, pollInterval = 1_000 }: WaitForAppToCloseOptions = {},
  ): Promise<void> {
    const deadline = Date.now() + timeout;
    let foreground = await this.getCurrentBundleId();

    while (foreground === appId && Date.now() < deadline) {
      await delay(pollInterval);
      foreground = await this.getCurrentBundleId();
    }

    if (foreground === appId) {
      throw new Error(`${appId} was still in the foreground ${timeout}ms later.`);
    }
  }

  /**
   * A path inside the app under test's own data container, in the form Appium's file commands
   * take: `@<package>/<relative>` on Android and `@<bundle>:data/<relative>` on iOS. The iOS
   * container type matters: Appium defaults to `app`, the read-only bundle, while everything the
   * app writes lives under `data`.
   *
   * Android container pulls go through `run-as`, which an emulator allows for any package but a
   * real device allows only for a debuggable build. iOS container pulls are verified on the
   * simulator; a real device supports the `documents` container alone.
   */
  appContainerPath(relativePath: string): string {
    const appId = this.getAppBundleId();
    const relative = trimLeadingSlashes(relativePath);
    return this.getPlatform() == Platform.ANDROID
      ? `@${appId}/${relative}`
      : `@${appId}:data/${relative}`;
  }

  /** The app's documents directory (`files/` on Android, `Documents/` on iOS). */
  appDocumentsPath(relativePath = ''): string {
    return this.appContainerPath(this.platformRelativePath('files', 'Documents', relativePath));
  }

  /** The app's cache directory (`cache/` on Android, `Library/Caches/` on iOS). */
  appCachePath(relativePath = ''): string {
    return this.appContainerPath(
      this.platformRelativePath('cache', 'Library/Caches', relativePath),
    );
  }

  /**
   * [Android] A path in the shared downloads directory, readable without `run-as`. iOS has no
   * public downloads directory: read a file the app wrote through `appDocumentsPath()`, or drive
   * the share sheet to a destination the test controls.
   */
  publicDownloadsPath(relativePath: string): string {
    if (this.getPlatform() != Platform.ANDROID) {
      throw new Error(
        'iOS has no public downloads directory. Use appDocumentsPath() to reach a file the app ' +
          'itself wrote, or drive the share sheet to a destination the test controls.',
      );
    }
    return `${ANDROID_DOWNLOADS_DIR}/${trimLeadingSlashes(relativePath)}`;
  }

  private platformRelativePath(androidRoot: string, iosRoot: string, relativePath: string): string {
    const root = this.getPlatform() == Platform.ANDROID ? androidRoot : iosRoot;
    const relative = trimLeadingSlashes(relativePath);
    return relative === '' ? root : `${root}/${relative}`;
  }

  /**
   * Reads a file off the device. `remotePath` is a device path or a container path from
   * `appContainerPath()` and friends.
   *
   * **Usage:**
   * ```js
   * const pdf = await device.pullFile(device.appCachePath('print/out.pdf'));
   * ```
   */
  @boxedStep
  async pullFile(remotePath: string): Promise<Buffer> {
    const base64 = await this.webDriverClient.pullFile(remotePath);
    return Buffer.from(base64, 'base64');
  }

  /**
   * Polls `pullFile()` until the file exists and `isReady` accepts its contents (by default:
   * it is non-empty). Neither driver distinguishes a missing file from a transport fault, so
   * every error is retried and only the last one is reported.
   *
   * **Usage:**
   * ```js
   * const pdf = await device.waitForFile(device.appCachePath('print/out.pdf'), {
   *   isReady: (contents) => contents.subarray(-1024).includes('%%EOF'),
   * });
   * ```
   */
  @boxedStep
  async waitForFile(
    remotePath: string,
    {
      timeout = 15_000,
      pollInterval = 500,
      isReady = (contents) => contents.length > 0,
    }: WaitForFileOptions = {},
  ): Promise<Buffer> {
    const deadline = Date.now() + timeout;
    let reason = 'it was never attempted';

    do {
      try {
        const contents = await this.pullFile(remotePath);
        if (isReady(contents)) {
          return contents;
        }
        reason = `the file exists but is not ready (${contents.length} bytes)`;
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
      await delay(pollInterval);
    } while (Date.now() < deadline);

    throw new Error(`Could not pull '${remotePath}' within ${timeout}ms: ${reason}`);
  }

  /**
   * @param [bundleId] - Optional bundleId of the app to terminate. If not provided, it will attempt to terminate the app under test.
   * It changes the context to NATIVE_APP after terminating the app.
   */
  @boxedStep
  async terminateApp(bundleId?: string) {
    let currentBundleId;
    if (!this.bundleId && !bundleId) {
      currentBundleId = await this.getCurrentBundleId();
      if (!currentBundleId) throw new Error('bundleId is required to terminate the app.');
    }
    const keyName = this.getPlatform() == Platform.ANDROID ? 'appId' : 'bundleId';
    await this.webDriverClient.executeScript('mobile: terminateApp', [
      {
        [keyName]: bundleId || this.bundleId || currentBundleId,
      },
    ]);
    // Switch to native context after terminating the app so that if the app is re-launched, webview
    // reads and switches correctly.
    await this.ensureNativeContext();
  }

  /**
   * @param [bundleId] - Optional bundleId of the app to activate. If not provided, it will attempt to activate the app under test.
   * It changes the context to NATIVE_APP after activating the app.
   */
  @boxedStep
  async activateApp(bundleId?: string) {
    if (!this.bundleId && !bundleId) {
      throw new Error('bundleId is required to activate the app.');
    }
    const keyName = this.getPlatform() == Platform.ANDROID ? 'appId' : 'bundleId';
    await this.webDriverClient.executeScript('mobile: activateApp', [
      {
        [keyName]: bundleId || this.bundleId,
      },
    ]);
    await this.ensureNativeContext();
  }

  /**
   * Sends the currently running app to the background.
   *
   * @param seconds - Number of seconds to keep app in background.
   *                  Use -1 to background indefinitely (until manually reactivated).
   *                  If positive number, app returns to foreground after specified seconds.
   *
   * @example
   * ```js
   * // Background for 10 seconds then auto-return
   * await device.backgroundApp(10);
   *
   * // Background indefinitely (for battery tests)
   * await device.backgroundApp(-1);
   * await device.waitForTimeout(30 * 60 * 1000); // Wait 30 minutes
   * await device.activateApp(); // Manually bring back
   * ```
   */
  @boxedStep
  async backgroundApp(seconds: number = -1): Promise<void> {
    await this.webDriverClient.executeScript('mobile: backgroundApp', [
      {
        seconds,
      },
    ]);
  }

  /**
   * Retrieves text content from the clipboard of the mobile device. This is useful
   * after a "copy to clipboard" action has been performed. This returns base64 encoded string.
   *
   * **Usage:**
   * ```js
   * const clipboardText = await device.getClipboardText();
   * ```
   *
   * @returns Returns the text content of the clipboard in base64 encoded string.
   */
  @boxedStep
  async getClipboardText(): Promise<string> {
    return await this.webDriverClient.executeScript('mobile: getClipboard', []);
  }

  /**
   * Sets a mock camera view using the specified image. This injects a mock image into the camera view.
   * Currently, this functionality is supported only for BrowserStack.
   *
   * **Usage:**
   * ```js
   * await device.setMockCameraView(`screenshot.png`);
   * ```
   *
   * @param imagePath path to the image file that will be used as the mock camera view.
   * @returns
   */
  @boxedStep
  async setMockCameraView(imagePath: string): Promise<void> {
    if (this.provider == 'browserstack') {
      const imageURL = await uploadImageToBS(imagePath);
      await this.webDriverClient.executeScript(
        `browserstack_executor: {"action":"cameraImageInjection", "arguments": {"imageUrl" : "${imageURL}"}}`,
        [],
      );
    } else if (this.provider == 'lambdatest') {
      const imageURL = await uploadImageToLambdaTest(imagePath);
      await this.webDriverClient.executeScript(`lambda-image-injection=${imageURL}`, []);
    }
  }

  /**
   * **[DEBUGGING ONLY]** Pauses test execution indefinitely to allow manual inspection via Appium Inspector.
   *
   * WARNING: This function runs an infinite loop and will NEVER complete.
   * Use only for debugging - remove before committing tests.
   * Automatically skipped in CI (when CI=true environment variable is set).
   *
   * **Usage:**
   * ```js
   * await device.pause(); // Pauses here forever - use Ctrl+C to stop
   * ```
   */
  @boxedStep
  async pause() {
    const skipPause = process.env.CI === 'true';
    if (skipPause) {
      return;
    }
    logger.log(`device.pause: Use Appium Inspector to attach to the session.`);
    let iterations = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      await this.webDriverClient.takeScreenshot();
      iterations += 1;
      if (iterations % 3 === 0) {
        logger.log(`device.pause: ${iterations * 20} secs elapsed.`);
      }
    }
  }

  /**
   * Waits for the specified amount of time (in milliseconds) before continuing.
   *
   * WARNING: There is a command timeout of 5 minutes for local-device and emulator and a
   * one minute timeout for all others.
   * If you wait longer than this without any other commands, the session will timeout.
   * For long waits, consider breaking them up or using device.backgroundApp() instead.
   *
   * **Usage:**
   * ```js
   * await device.waitForTimeout(5000); // Wait 5 seconds
   * ```
   *
   * @param timeout Time to wait in milliseconds
   */
  @boxedStep
  async waitForTimeout(timeout: number) {
    await new Promise((resolve) => setTimeout(resolve, timeout));
  }

  /**
   * Get a screenshot of the current screen as a base64 encoded string.
   */
  @boxedStep
  async screenshot(): Promise<string> {
    return await this.webDriverClient.takeScreenshot();
  }

  /**
   * [iOS Only]
   * Scroll the screen from 0.2 to 0.8 of the screen height.
   * This can be used for controlled scroll, for auto scroll checkout `scroll` method from locator.
   *
   * **Usage:**
   * ```js
   * await device.scroll();
   * ```
   *
   */
  @boxedStep
  async scroll(): Promise<void> {
    const driverSize = await this.webDriverClient.getWindowRect();
    // Scrolls from 0.8 to 0.2 of the screen height
    const from = { x: driverSize.width / 2, y: driverSize.height * 0.8 };
    const to = { x: driverSize.width / 2, y: driverSize.height * 0.2 };
    await this.webDriverClient.executeScript('mobile: dragFromToForDuration', [
      {
        duration: 2,
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
      },
    ]);
  }

  /**
   * Send keys to already focused input field.
   * To fill input fields using the selectors use `sendKeyStrokes` method from locator
   */
  @boxedStep
  async sendKeyStrokes(value: string): Promise<void> {
    const actions = value
      .split('')
      .map((char) => [
        { type: 'keyDown', value: char },
        { type: 'keyUp', value: char },
      ])
      .flat();

    await this.webDriverClient.performActions([
      {
        type: 'key',
        id: 'keyboard',
        actions: actions,
      },
    ]);

    await this.webDriverClient.releaseActions();
  }

  /**
   * Get all available contexts (NATIVE_APP and WEBVIEW contexts).
   * @internal Used internally for automatic context switching
   */
  async contexts(): Promise<ReturnType<WebDriverClient['getAppiumContexts']>> {
    return await this.webDriverClient.getAppiumContexts();
  }

  /**
   * Get the current context.
   * @internal Used internally for automatic context switching
   */
  async getCurrentContext(): Promise<string> {
    const context = await this.webDriverClient.getAppiumContext();
    const contextName = typeof context === 'string' ? context : context.title;
    if (!contextName) {
      throw new Error('Unable to get current context name.');
    }
    return contextName;
  }

  /**
   * Switch to a specific context by name.
   * @internal Used internally for automatic context switching
   */
  async switchContext(contextName: string): Promise<void> {
    await this.webDriverClient.switchAppiumContext(contextName);
  }

  private async switchToNativeContext(): Promise<void> {
    await this.switchContext(NATIVE_CONTEXT);
  }

  /**
   * Execute JavaScript code in the current context.
   *
   * @param script - JavaScript code to execute (string or function)
   * @returns Result of the script execution
   */
  @boxedStep
  async evaluate<T = any>(script: string | Function): Promise<T> {
    const scriptString = typeof script === 'function' ? `return (${script.toString()})()` : script;
    return await this.webDriverClient.executeScript(scriptString, []);
  }

  async getWindowHandles(): Promise<string[]> {
    return await this.webDriverClient.getWindowHandles();
  }

  async getCurrentWindowHandle(): Promise<string> {
    return await this.webDriverClient.getWindowHandle();
  }
}
