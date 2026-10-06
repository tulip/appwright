import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import type { Client as WebDriverClient } from 'webdriver';
import type { z } from 'zod';

import { CHAIN_METHODS, Locator } from '../locator';
import { LocatorQuery, nativeIdQuery, nativeLabelQuery, nativeTextQuery } from '../locator/queries';
import { logger } from '../logger';
import { readBuildInfo } from '../providers/appium';
import { uploadImageToBS } from '../providers/browserstack/utils';
import { uploadImageToLambdaTest } from '../providers/lambdatest/utils';
import {
  AlertButtonOptions,
  AppState,
  AppwrightLocator,
  BuildInfo,
  DeviceOrientation,
  DragOptions,
  ExtractType,
  IdOptions,
  LabelOptions,
  NATIVE_CONTEXT,
  OpenUrlOptions,
  Platform,
  Rect,
  ScreenEdge,
  SetOrientationOptions,
  SwipeFromEdgeOptions,
  TerminateAppOptions,
  TextOptions,
  TimeoutOptions,
  VisionModel,
  WaitForAppToCloseOptions,
  WaitForFileOptions,
  WaitForWebPageOptions,
  WebPage,
} from '../types';
import { boxedStep, contextName, delay, errorMessage, urlMatches } from '../utils';
import { AppwrightVision, VisionProvider } from '../vision';
import { hasLoadedUrl, toWebPages } from './web-pages';

/** Providers whose devices are in a cloud: a local build file cannot be installed on them. */
const CLOUD_PROVIDERS = ['browserstack', 'lambdatest'];

/** Only this provider keeps an iOS app's data container where `mobile: clearApp` can reach it. */
const IOS_SIMULATOR_PROVIDER = 'emulator';

/** Public, so a pull from here needs no `run-as`. */
const ANDROID_DOWNLOADS_DIR = '/sdcard/Download';

/**
 * Where the drivers report the device a session landed on: UiAutomator2 as `deviceUDID` (the adb
 * serial), XCUITest as `udid`, overwritten with the device it actually picked.
 */
const UDID_CAPABILITIES = ['deviceUDID', 'appium:deviceUDID', 'udid', 'appium:udid'];

/**
 * How `simctl terminate` says the app was not running: it exits with the POSIX error it got,
 * ESRCH (3), and prints this. Other failures exit with other codes (148 for an unknown device), so
 * the code is the signal; the text covers a simctl that changes its exit codes.
 */
const SIMCTL_NO_SUCH_PROCESS = 3;
const SIMCTL_NOT_RUNNING = 'found nothing to terminate';

/** Android's `KEYCODE_BACK`. */
const ANDROID_KEYCODE_BACK = 4;

/** Android's baseline density: a dp is `dpi / 160` physical pixels. */
const ANDROID_BASELINE_DPI = 160;

const ORIENTATION_TIMEOUT_MS = 10_000;
const ORIENTATION_POLL_MS = 250;

/**
 * WebDriverAgent's refusal to rotate: the home screen (SpringBoard) is portrait-only, and a modal
 * mid-animation refuses too. Matched against the error text, the only signal WDA gives; if the
 * wording changes, the refusal comes through without the explanation.
 */
const IOS_CANNOT_ROTATE = 'Unable To Rotate Device';

/** WebDriverAgent's `defaultAlertAction` values. */
const ALERT_ACCEPT = 'accept';
const ALERT_DISMISS = 'dismiss';
const ALERT_NONE = '';

const DRAG_DURATION_MS = 400;

/** Held after the press so the touch reads as a drag, not a fling or a long press. */
const DRAG_HOLD_MS = 100;

const WEB_PAGE_TIMEOUT_MS = 30_000;
const WEB_PAGE_POLL_MS = 500;

const execFilePromise = promisify(execFile);

function trimLeadingSlashes(relativePath: string): string {
  return relativePath.replace(/^\/+/, '');
}

/** The driver reports `PORTRAIT` / `LANDSCAPE`; some report lower case or a variant. */
function toDeviceOrientation(reported: string): DeviceOrientation {
  const upper = String(reported).toUpperCase();
  if (upper.includes('LANDSCAPE')) {
    return DeviceOrientation.LANDSCAPE;
  }
  if (upper.includes('PORTRAIT')) {
    return DeviceOrientation.PORTRAIT;
  }
  throw new Error(`The driver reported an orientation appwright does not know: "${reported}".`);
}

function shapeOf({ width, height }: Rect): DeviceOrientation | undefined {
  if (width > height) {
    return DeviceOrientation.LANDSCAPE;
  }
  return width < height ? DeviceOrientation.PORTRAIT : undefined;
}

export class Device {
  /**
   * WebDriverAgent's `defaultAlertAction` in this session: what the capabilities set it to,
   * until `setAlertAutoAccept()` changes it. Appium has no way to read the setting back.
   */
  private alertAction?: string;

  /** Set once `setOrientation()` runs, so the fixture rotates the device back after the test. */
  private rotated = false;

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
    description,
    web = false,
    wrap,
  }: LocatorQuery & {
    /** Set by `WebView`: the locator resolves in a WEBVIEW context and edits through the DOM. */
    web?: boolean;
    /** Wraps the locators chained off this one, as the caller wraps this one. */
    wrap?: (locator: Locator) => AppwrightLocator;
  }): Locator {
    return new Locator(
      this.webDriverClient,
      this.timeoutOpts,
      selector,
      findStrategy,
      textToMatch,
      web,
      { description, wrap },
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

        // `getByText()` and friends only build a locator; the child comes back wrapped.
        if (CHAIN_METHODS.has(prop)) {
          return (original as Function).bind(target);
        }

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

  locator({ selector, findStrategy, textToMatch, description }: LocatorQuery): AppwrightLocator {
    const originalLocator = this.createLocator({
      selector,
      findStrategy,
      textToMatch,
      description,
      wrap: (child) => this.wrapWithNativeContext(child),
    });
    return this.wrapWithNativeContext(originalLocator);
  }

  private isAndroid(): boolean {
    return this.getPlatform() == Platform.ANDROID;
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
        model?: VisionModel;
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
  getByText(text: string | RegExp, options: TextOptions = {}): AppwrightLocator {
    return this.locator(nativeTextQuery(this.isAndroid(), text, options));
  }

  /**
   * Locate an element on the screen with accessibility identifier (`resource-id` on Android,
   * `name` on iOS). Defaults to an exact match; set `exact: false` for a substring match.
   * Pass `editable: true` to restrict the match to text fields, as `getByLabel()` does.
   *
   * **Usage:**
   * ```js
   * const element = await device.getById("signup_button");
   * await device.getById("android:id/title", { editable: true }).fill("report");
   * ```
   *
   * @param text string to search for
   * @param options
   * @returns
   */
  getById(text: string, options: IdOptions = {}): AppwrightLocator {
    return this.locator(nativeIdQuery(this.isAndroid(), text, options));
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
  getByLabel(label: string, options: LabelOptions = {}): AppwrightLocator {
    return this.locator(nativeLabelQuery(this.isAndroid(), label, options));
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
   * [iOS] Locate an element with a raw NSPredicate, for a match `getByLabel()` / `getById()`
   * cannot express — on `value`, or on a type other than a text field. The attribute names are
   * the ones XCUITest's page source shows (`name`, `label`, `value`, `type`, …). Fails at the
   * first lookup on Android, which has no such strategy.
   *
   * **Usage:**
   * ```js
   * await device.getByIosPredicate('type == "XCUIElementTypeButton" AND label BEGINSWITH "Sign"').tap();
   * ```
   */
  getByIosPredicate(predicate: string): AppwrightLocator {
    return this.locator({ selector: predicate, findStrategy: '-ios predicate string' });
  }

  /**
   * [Android] Locate an element with a raw UiSelector expression, e.g. to combine a resource id
   * with a class. Fails at the first lookup on iOS, which has no such strategy.
   *
   * **Usage:**
   * ```js
   * await device.getByAndroidUiAutomator('new UiSelector().resourceId("android:id/button1").className("android.widget.Button")').tap();
   * ```
   */
  getByAndroidUiAutomator(selector: string): AppwrightLocator {
    return this.locator({ selector, findStrategy: '-android uiautomator' });
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
   * What the build file declares about itself — bundle id, version and build number — read on
   * the host from the project's `buildPath` (`.app`, `.ipa` or `.apk`), so a test can compare
   * the version the app shows with the one it was built as. An `.apk` needs `ANDROID_HOME`,
   * for `aapt`.
   *
   * **Usage:**
   * ```js
   * const { version } = await device.getBuildInfo();
   * await expect(device.getByText(version, { exact: true })).toBeVisible();
   * ```
   *
   * @param buildPath Defaults to the project's `buildPath`.
   */
  async getBuildInfo(buildPath: string | undefined = this.buildPath): Promise<BuildInfo> {
    if (!buildPath) {
      throw new Error(
        'getBuildInfo() needs a build path: none was given and the project has no `buildPath`.',
      );
    }
    return await readBuildInfo(buildPath);
  }

  /**
   * The run state of `appId` (by default the app under test): not installed, not running,
   * suspended, in the background or in front. Both drivers' terminate already waits for the app
   * to stop; this is how a test proves a relaunch really relaunched. Leaves the session in
   * NATIVE_APP.
   *
   * **Usage:**
   * ```js
   * await device.terminateApp();
   * expect(await device.getAppState()).toBe(AppState.NotRunning);
   * await device.activateApp();
   * ```
   */
  async getAppState(appId: string = this.getAppBundleId()): Promise<AppState> {
    await this.ensureNativeContext();
    return await this.executeMobileCommand<AppState>('mobile: queryAppState', this.appIdArg(appId));
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

  /**
   * Whether this is an iOS simulator: the one kind of device whose app containers are host
   * directories and that `xcrun simctl` can drive. An Android emulator is not a simulator here —
   * use `getProvider() === 'emulator'` for "not a physical device" on either platform.
   */
  isSimulator(): boolean {
    return this.getPlatform() == Platform.IOS && this.provider === IOS_SIMULATOR_PROVIDER;
  }

  /**
   * The device this session is driving, as the driver reports it: the adb serial on Android
   * (`emulator-5554`), the device or simulator UDID on iOS. With several devices configured it
   * is the one this worker's slot was given, so read it here rather than from an environment
   * variable or `simctl list`, which cannot tell the workers' devices apart.
   *
   * Throws when the session's capabilities carry no udid.
   */
  getUdid(): string {
    const capabilities = (this.webDriverClient.capabilities ?? {}) as Record<string, unknown>;
    for (const key of UDID_CAPABILITIES) {
      const udid = capabilities[key];
      if (typeof udid === 'string' && udid !== '') {
        return udid;
      }
    }
    throw new Error(
      `The session reported no udid (looked for ${UDID_CAPABILITIES.join(', ')} in its ` +
        `capabilities). The '${this.provider}' provider's driver may not expose one.`,
    );
  }

  /**
   * [iOS simulator] The host directory backing a path inside the app under test's data
   * container, for reading what the app wrote with ordinary `fs` calls rather than through
   * Appium. The container is named by an install-time UUID, so `xcrun simctl` is asked for it;
   * a reinstall moves it. `appContainerPath()` with `pullFile()` is the route that works on
   * every device.
   */
  async simulatorContainerPath(relativePath = ''): Promise<string> {
    this.requireSimulator('simulatorContainerPath()');
    const appId = this.getAppBundleId();
    const udid = this.getUdid();
    let container: string;
    try {
      const { stdout } = await execFilePromise('xcrun', [
        'simctl',
        'get_app_container',
        udid,
        appId,
        'data',
      ]);
      container = stdout.trim();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not locate the data container of '${appId}' on simulator ${udid}: ${reason}`,
      );
    }
    return path.join(container, trimLeadingSlashes(relativePath));
  }

  private requireSimulator(what: string): void {
    if (this.isSimulator()) {
      return;
    }
    const device =
      this.getPlatform() == Platform.IOS ? `a '${this.provider}' iOS device` : 'an Android device';
    throw new Error(
      `${what} needs an iOS simulator, which \`xcrun simctl\` can reach; this is ${device}.`,
    );
  }

  /**
   * Whether the software keyboard is on screen. The accessibility tree does not show the IME on
   * Android, so a locator cannot answer this.
   */
  async isKeyboardShown(): Promise<boolean> {
    await this.ensureNativeContext();
    return await this.webDriverClient.isKeyboardShown();
  }

  /**
   * Dismisses the software keyboard if it is up; a no-op otherwise. Use it before tapping a
   * control below a focused field: the keyboard can cover it, and some screens swallow the first
   * tap outside a focused field to dismiss the keyboard instead of delivering it.
   *
   * On iOS the driver taps a dismiss key (`Done` by default); pass the key's label for keyboards
   * that use another one, e.g. `hideKeyboard('Return')`.
   */
  @boxedStep
  async hideKeyboard(iosKeyName?: string): Promise<void> {
    if (!(await this.isKeyboardShown())) {
      return;
    }
    if (this.getPlatform() == Platform.IOS) {
      await this.executeMobileCommand('mobile: hideKeyboard', {
        keys: iosKeyName == null ? [] : [iosKeyName],
      });
    } else {
      await this.webDriverClient.hideKeyboard();
    }
    if (await this.isKeyboardShown()) {
      throw new Error(
        'hideKeyboard: the software keyboard is still on screen' +
          (this.getPlatform() == Platform.IOS
            ? ". Pass the label of the keyboard's dismiss key, e.g. hideKeyboard('Return')."
            : '.'),
      );
    }
  }

  /**
   * [iOS] Turns WebDriverAgent's automatic alert answering on or off. Every appwright provider
   * creates the session with `appium:autoAcceptAlerts`, under which WebDriverAgent taps the last
   * button of any alert within about two seconds — system permission prompts, but also the app's
   * own `Alert.alert` confirmations, before the test can look at them. Turn it off around a step
   * that has to see or answer an alert itself, or use `withAlertAutoAccept()`.
   *
   * A no-op on Android, which answers no alert by itself (`appium:autoGrantPermissions` covers
   * permission prompts there).
   */
  @boxedStep
  async setAlertAutoAccept(enabled: boolean): Promise<void> {
    if (this.getPlatform() != Platform.IOS) {
      logger.log('setAlertAutoAccept: nothing to do on Android, which answers no alert by itself.');
      return;
    }
    await this.applyAlertAction(enabled ? ALERT_ACCEPT : ALERT_NONE);
  }

  /**
   * Runs `fn` with alert auto-accept set to `enabled` (see `setAlertAutoAccept()`), then restores
   * what the session had before. When `fn` throws, its error is the one reported: a restore that
   * fails after it is only logged. On Android this only runs `fn`.
   *
   * **Usage:**
   * ```js
   * await device.withAlertAutoAccept(false, async () => {
   *   await device.getById("clear-instance-button").tap();
   *   expect(await device.getAlertText()).toContain("Are you sure?");
   *   await device.acceptAlert({ buttonLabel: "Clear Data" });
   * });
   * ```
   */
  async withAlertAutoAccept<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
    const previous = this.currentAlertAction();
    await this.setAlertAutoAccept(enabled);

    let result: T;
    try {
      result = await fn();
    } catch (error) {
      await this.applyAlertAction(previous).catch((restoreError: unknown) => {
        logger.warn(
          `withAlertAutoAccept: could not restore defaultAlertAction "${previous}": ` +
            errorMessage(restoreError),
        );
      });
      throw error;
    }
    await this.applyAlertAction(previous);
    return result;
  }

  private currentAlertAction(): string {
    if (this.alertAction === undefined) {
      const capabilities = (this.webDriverClient.capabilities ?? {}) as Record<string, unknown>;
      const capability = (name: string) => capabilities[name] ?? capabilities[`appium:${name}`];
      this.alertAction =
        capability('autoAcceptAlerts') === true
          ? ALERT_ACCEPT
          : capability('autoDismissAlerts') === true
          ? ALERT_DISMISS
          : ALERT_NONE;
    }
    return this.alertAction;
  }

  private async applyAlertAction(action: string): Promise<void> {
    if (this.getPlatform() != Platform.IOS) {
      return;
    }
    await this.webDriverClient.updateSettings({ defaultAlertAction: action });
    this.alertAction = action;
  }

  /**
   * Answers the alert on screen with its accept button — XCUITest's default accept button on iOS,
   * the dialog's positive button on Android — or with the button labelled `buttonLabel`. Covers
   * the app's own alerts as well as system prompts. On iOS, turn auto-accept off first or
   * WebDriverAgent may answer before the test does (`withAlertAutoAccept()`). Leaves the session
   * in NATIVE_APP.
   */
  @boxedStep
  async acceptAlert({ buttonLabel }: AlertButtonOptions = {}): Promise<void> {
    await this.answerAlert(ALERT_ACCEPT, buttonLabel);
  }

  /** Answers the alert on screen with its dismiss (cancel) button; see `acceptAlert()`. */
  @boxedStep
  async dismissAlert({ buttonLabel }: AlertButtonOptions = {}): Promise<void> {
    await this.answerAlert(ALERT_DISMISS, buttonLabel);
  }

  private async answerAlert(
    action: typeof ALERT_ACCEPT | typeof ALERT_DISMISS,
    buttonLabel?: string,
  ): Promise<void> {
    await this.ensureNativeContext();
    const label = buttonLabel == null ? {} : { buttonLabel };
    if (this.isAndroid()) {
      const command = action === ALERT_ACCEPT ? 'mobile: acceptAlert' : 'mobile: dismissAlert';
      await this.executeMobileCommand(command, label);
    } else {
      await this.executeMobileCommand('mobile: alert', { action, ...label });
    }
  }

  /** The title and message of the alert on screen. Leaves the session in NATIVE_APP. */
  async getAlertText(): Promise<string> {
    await this.ensureNativeContext();
    return await this.webDriverClient.getAlertText();
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
    if (this.getPlatform() == Platform.IOS && !this.isSimulator()) {
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
   * when the build has not changed. Works on Android and the iOS simulator; a physical iOS device
   * exposes no data container, so it throws there — use `reinstallApp()`.
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
   * @param [options] - `force: true` kills the process with `xcrun simctl terminate` on an iOS
   * simulator, for bundle ids WebDriverAgent cannot terminate (see `TerminateAppOptions`).
   * It changes the context to NATIVE_APP after terminating the app.
   */
  @boxedStep
  async terminateApp(bundleId?: string, { force = false }: TerminateAppOptions = {}) {
    let currentBundleId;
    if (!this.bundleId && !bundleId) {
      currentBundleId = await this.getCurrentBundleId();
      if (!currentBundleId) throw new Error('bundleId is required to terminate the app.');
    }
    const appId = (bundleId || this.bundleId || currentBundleId)!;
    if (force && this.getPlatform() == Platform.IOS) {
      await this.terminateSimulatorProcess(appId);
    } else {
      const keyName = this.getPlatform() == Platform.ANDROID ? 'appId' : 'bundleId';
      await this.webDriverClient.executeScript('mobile: terminateApp', [{ [keyName]: appId }]);
    }
    // Switch to native context after terminating the app so that if the app is re-launched, webview
    // reads and switches correctly.
    await this.ensureNativeContext();
  }

  private async terminateSimulatorProcess(appId: string): Promise<void> {
    this.requireSimulator('terminateApp({ force: true })');
    const udid = this.getUdid();
    try {
      await execFilePromise('xcrun', ['simctl', 'terminate', udid, appId]);
    } catch (error) {
      const { code, stderr: rawStderr } = error as { code?: unknown; stderr?: unknown };
      const stderr = String(rawStderr ?? '');
      if (code !== SIMCTL_NO_SUCH_PROCESS && !stderr.includes(SIMCTL_NOT_RUNNING)) {
        throw new Error(
          `xcrun simctl terminate ${udid} ${appId} failed: ${stderr.trim() || error}`,
        );
      }
      logger.log(`terminateApp: ${appId} was not running on ${udid}.`);
    }
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
   * The app window's position and size in the driver's units (see `Rect`). On iOS it is the
   * window of the app in front: SpringBoard's, portrait, while the app under test is not.
   * Leaves the session in NATIVE_APP.
   */
  async getWindowRect(): Promise<Rect> {
    await this.ensureNativeContext();
    const { x, y, width, height } = await this.webDriverClient.getWindowRect();
    return { x, y, width, height };
  }

  /**
   * The orientation the driver reports. On iOS it is the orientation of the app in front, so it
   * reads portrait while the home screen is up whatever way the device is held. Leaves the
   * session in NATIVE_APP.
   */
  async getOrientation(): Promise<DeviceOrientation> {
    await this.ensureNativeContext();
    return toDeviceOrientation(await this.webDriverClient.getOrientation());
  }

  /**
   * Rotates the device and returns the window rectangle once the rotation has taken effect: the
   * driver reports `orientation` and the window has its shape (wider than tall for landscape).
   * The project's `device.orientation` applies only when a session starts; this rotates
   * mid-test. After a test that rotated, the `device` fixture rotates the device back to the
   * configured orientation, since a rotation outlives the session.
   *
   * On iOS the app under test has to be in front — the home screen is portrait-only — and no
   * modal may be mid-animation, or WebDriverAgent answers "Unable To Rotate Device". That refusal
   * is not retried, which would hide a real one. Leaves the session in NATIVE_APP.
   *
   * **Usage:**
   * ```js
   * const window = await device.setOrientation(DeviceOrientation.LANDSCAPE);
   * ```
   */
  @boxedStep
  async setOrientation(
    orientation: DeviceOrientation,
    { timeout = ORIENTATION_TIMEOUT_MS }: SetOrientationOptions = {},
  ): Promise<Rect> {
    await this.ensureNativeContext();
    try {
      await this.webDriverClient.setOrientation(orientation.toUpperCase());
    } catch (error) {
      if (!errorMessage(error).includes(IOS_CANNOT_ROTATE)) {
        throw error;
      }
      throw new Error(
        `setOrientation(${orientation}): WebDriverAgent refused to rotate. On iOS the app under ` +
          'test has to be in front (the home screen is portrait-only) and no modal may be ' +
          `mid-animation. ${errorMessage(error)}`,
      );
    }
    this.rotated = true;

    const deadline = Date.now() + timeout;
    for (;;) {
      const reported = await this.getOrientation();
      const window = await this.getWindowRect();
      if (reported === orientation && shapeOf(window) === orientation) {
        return window;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `setOrientation(${orientation}): the device did not settle within ${timeout}ms. The ` +
            `driver reports ${reported} and the window is ${window.width}x${window.height}.`,
        );
      }
      await delay(ORIENTATION_POLL_MS);
    }
  }

  /**
   * Rotates the device back to `orientation` after a test that rotated it, with the app under
   * test brought to the front first, as iOS requires. Failures are logged, not thrown: the
   * test's own result stands.
   * @internal Called by the `device` fixture.
   */
  async restoreOrientation(orientation: DeviceOrientation): Promise<void> {
    if (!this.rotated) {
      return;
    }
    try {
      if (this.bundleId && (await this.getCurrentBundleId()) !== this.bundleId) {
        await this.activateApp();
      }
      await this.setOrientation(orientation);
    } catch (error) {
      logger.warn(
        `Could not rotate the device back to ${orientation} after the test: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Drags one finger from `from` to `to` with W3C pointer actions: press, hold 100 ms so the
   * touch reads as a drag rather than a fling, move over `duration`, lift. Positions are in the
   * driver's units (see `Rect`), so a `boundingBox()` or `getWindowRect()` can be used as is.
   * Leaves the session in NATIVE_APP.
   *
   * **Usage:**
   * ```js
   * const box = await device.getById("slider-thumb").boundingBox();
   * const y = box.y + box.height / 2;
   * await device.drag({ from: { x: box.x + 5, y }, to: { x: box.x + 200, y } });
   * ```
   */
  @boxedStep
  async drag({ from, to, duration = DRAG_DURATION_MS }: DragOptions): Promise<void> {
    await this.ensureNativeContext();
    await this.webDriverClient.performActions([
      {
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: Math.round(from.x), y: Math.round(from.y) },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: DRAG_HOLD_MS },
          { type: 'pointerMove', duration, x: Math.round(to.x), y: Math.round(to.y) },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
    await this.webDriverClient.releaseActions();
  }

  /**
   * Swipes in from the left or right edge of the window, as for opening a drawer or the back
   * swipe. The finger goes down `inset` points (iOS) or dp (Android) in from the edge, at `y` (a
   * fraction of the window height), and travels `distance` (a fraction of the window width).
   * Leaves the session in NATIVE_APP.
   *
   * **Usage:**
   * ```js
   * await device.swipeFromEdge("right");
   * ```
   */
  @boxedStep
  async swipeFromEdge(
    edge: ScreenEdge,
    { inset = 2, distance = 0.7, y = 0.5, duration = DRAG_DURATION_MS }: SwipeFromEdgeOptions = {},
  ): Promise<void> {
    const window = await this.getWindowRect();
    const left = window.x;
    const right = window.x + window.width - 1;
    const startOffset = inset * (await this.pixelsPerPoint());
    const travel = window.width * distance;
    const startX = edge === 'right' ? right - startOffset : left + startOffset;
    const endX = edge === 'right' ? startX - travel : startX + travel;
    const atY = window.y + window.height * y;

    await this.drag({
      from: { x: startX, y: atY },
      to: { x: Math.min(Math.max(endX, left), right), y: atY },
      duration,
    });
  }

  /** Driver units per point (iOS) or dp (Android): 1 on iOS, the display density on Android. */
  private async pixelsPerPoint(): Promise<number> {
    if (!this.isAndroid()) {
      return 1;
    }
    const dpi = await this.executeMobileCommand<number>('mobile: getDisplayDensity');
    return dpi / ANDROID_BASELINE_DPI;
  }

  /**
   * [Android] Presses the system back key. Throws on iOS, which has none: tap the app's own back
   * control, or `swipeFromEdge('left')` on screens that support the back swipe. Leaves the
   * session in NATIVE_APP.
   */
  @boxedStep
  async pressBack(): Promise<void> {
    if (!this.isAndroid()) {
      throw new Error(
        "pressBack() is Android only: iOS has no back key. Tap the app's own back control, or " +
          "swipeFromEdge('left') on screens that support the back swipe.",
      );
    }
    await this.ensureNativeContext();
    await this.executeMobileCommand('mobile: pressKey', { keycode: ANDROID_KEYCODE_BACK });
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
    const name = contextName(await this.webDriverClient.getAppiumContext());
    if (!name) {
      throw new Error('Unable to get current context name.');
    }
    return name;
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

  /**
   * The native view hierarchy as XML — UiAutomator2's dump on Android, XCUITest's on iOS — for
   * finding the attributes a locator can match on. Read from NATIVE_APP whatever context is
   * active, then switched back, so a call between two `webView` steps leaves the WebView bound.
   * For a page's HTML, use `webView.evaluate(() => document.documentElement.outerHTML)`.
   */
  async getPageSource(): Promise<string> {
    const previous = await this.getCurrentContext();
    if (previous === NATIVE_CONTEXT) {
      return await this.webDriverClient.getPageSource();
    }
    await this.switchToNativeContext();
    try {
      return await this.webDriverClient.getPageSource();
    } finally {
      try {
        await this.switchContext(previous);
      } catch (error) {
        // The page behind `previous` can be gone by now. That must not cost the caller the source:
        // the next `webView` call finds a WebView again from NATIVE_APP.
        logger.warn(
          `getPageSource: could not switch back to ${previous}, staying in NATIVE_APP: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  async getWindowHandles(): Promise<string[]> {
    return await this.webDriverClient.getWindowHandles();
  }

  async getCurrentWindowHandle(): Promise<string> {
    return await this.webDriverClient.getWindowHandle();
  }

  /**
   * Switches to the window `handle` names. In a WEBVIEW context a window is one page: a browser
   * context such as `WEBVIEW_chrome` spans every open tab, and this picks which one chromedriver
   * drives. `webView.attach({ pageUrl })` does the search by URL for you.
   */
  async switchToWindow(handle: string): Promise<void> {
    await this.webDriverClient.switchToWindow(handle);
  }

  /** The URL of the page the current WEBVIEW context is driving. */
  async getUrl(): Promise<string> {
    return await this.webDriverClient.getUrl();
  }

  /**
   * Every WebView page the session can see, read natively through `mobile: getContexts` without
   * attaching to any: the app's own pages, a popup's, and on Android every tab of a browser in
   * front. Leaves the session in NATIVE_APP.
   */
  async webPages(): Promise<WebPage[]> {
    await this.ensureNativeContext();
    return toWebPages(
      this.isAndroid(),
      await this.executeMobileCommand<unknown>('mobile: getContexts'),
    );
  }

  /**
   * Waits for a page that is not among `notIn` to load (a new popup reads `about:blank` for about
   * a second first) and returns it: a `window.open()` popup, an OAuth window, a new tab, the
   * WebView an app rebuilt. Take `notIn` from `webPages()` just before the step that opens the
   * page, and bind the page with `webView.attach({ page })`: plain discovery would bind the first
   * WebView, not the new one. Leaves the session in NATIVE_APP.
   *
   * **Usage:**
   * ```js
   * const before = await device.webPages();
   * await webView.getByRole("link", { name: "Open PDF" }).tap();
   * const popup = await device.waitForWebPage({ notIn: before, url: ".pdf" });
   * await webView.attach({ page: popup });
   * ```
   */
  @boxedStep
  async waitForWebPage({
    notIn = [],
    url,
    timeout = WEB_PAGE_TIMEOUT_MS,
    pollInterval = WEB_PAGE_POLL_MS,
  }: WaitForWebPageOptions = {}): Promise<WebPage> {
    // A page keeps its key through reloads and navigations on both platforms, so a page under a
    // new key is new even at a URL `notIn` has: a second tab, the WebView an app rebuilt.
    const knownKeys = new Set(notIn.map((page) => page.key));
    const deadline = Date.now() + timeout;

    for (;;) {
      const fresh = (await this.webPages()).filter((page) => !knownKeys.has(page.key));
      const found = fresh.find(
        (page) => hasLoadedUrl(page) && (url == null || urlMatches(page.url, url)),
      );
      if (found) {
        return found;
      }
      if (Date.now() >= deadline) {
        const wanted = url == null ? 'a loaded URL' : `a URL matching ${String(url)}`;
        throw new Error(
          `waitForWebPage: no new page with ${wanted} within ${timeout}ms. New pages seen: ` +
            JSON.stringify(fresh.map((page) => page.url)),
        );
      }
      await delay(pollInterval);
    }
  }
}
