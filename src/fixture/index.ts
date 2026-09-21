import { ExpectMatcherState, FullProject, test as base } from '@playwright/test';

import { Device } from '../device';
import { createDeviceProvider } from '../providers';
import {
  ActionOptions,
  AppwrightConfig,
  AppwrightLocator,
  CleanDeviceOptions,
  DeviceProvider,
  Platform,
} from '../types';
import { TimeoutError } from '../types/errors';
import { WebView } from '../webView';
import { WorkerInfoStore } from './workerInfo';

type TestLevelFixtures = {
  /**
   * Device provider to be used for the test.
   * This creates and manages the device lifecycle for the test
   */
  deviceProvider: DeviceProvider;

  /**
   * The device instance that will be used for running the test.
   * This provides the functionality to interact with the device
   * during the test.
   */
  device: Device;

  /**
   * The webView instance for interacting with WebView content.
   * This is only available when your app has a WebView.
   * Automatically switches to WebView context when using webView methods.
   */
  webView: WebView;
};

type WorkerLevelFixtures = {
  persistentDevice: Device;
};

export const test = base.extend<TestLevelFixtures, WorkerLevelFixtures>({
  deviceProvider: async ({}, use, testInfo) => {
    const deviceProvider = createDeviceProvider(testInfo.project, testInfo.parallelIndex);
    await use(deviceProvider);
  },
  device: async ({ deviceProvider }, use, testInfo) => {
    const device = await deviceProvider.getDevice();
    const platform = (testInfo.project as FullProject<AppwrightConfig>).use.platform;

    // For Android, activate the app before running the test to ensure it's in the foreground.
    if (platform === Platform.ANDROID) {
      try {
        await device.activateApp();
      } catch (error) {
        // Silently ignore activation errors
        console.log('[Fixture] Failed to activate app:', error);
      }
    }

    const deviceProviderName = (testInfo.project as FullProject<AppwrightConfig>).use.device
      ?.provider;
    testInfo.annotations.push({
      type: 'providerName',
      description: deviceProviderName,
    });
    testInfo.annotations.push({
      type: 'sessionId',
      description: deviceProvider.sessionId,
    });
    await deviceProvider.syncTestDetails?.({ name: testInfo.title });
    await use(device);
    await device.close();
    await deviceProvider.syncTestDetails?.({
      name: testInfo.title,
      status: testInfo.status,
      reason: testInfo.error?.message,
    });
  },
  webView: async ({ device }, use) => {
    const webView = new WebView(device);
    await use(webView);
  },
  persistentDevice: [
    async ({}, use, workerInfo) => {
      const { project, workerIndex, parallelIndex } = workerInfo;
      const beforeSession = new Date();
      const deviceProvider = createDeviceProvider(project, parallelIndex);
      const device = await deviceProvider.getDevice();
      const sessionId = deviceProvider.sessionId;
      if (!sessionId) {
        throw new Error('Worker must have a sessionId.');
      }
      const providerName = (project as FullProject<AppwrightConfig>).use.device?.provider;
      const afterSession = new Date();
      const workerInfoStore = new WorkerInfoStore();
      await workerInfoStore.saveWorkerStartTime(
        workerIndex,
        sessionId,
        providerName!,
        beforeSession,
        afterSession,
      );
      await use(device);
      await workerInfoStore.saveWorkerEndTime(workerIndex, new Date());
      await device.close();
    },
    { scope: 'worker' },
  ],
});

/**
 * Declare at the top of a `describe` block what state that block needs the app in:
 *
 * ```js
 * test.describe.serial('printing', () => {
 *   useCleanDevice({ appReset: 'reinstall' });
 *   ...
 * });
 * ```
 *
 * **Cost.** Playwright instantiates test-scoped fixtures inside a `beforeAll` and tears them down
 * when the hook ends, so one hook is one Appium session and a `newSession` is seconds, not
 * milliseconds. This registers a single `beforeAll`; call it once per block. Anything else the
 * block needs done on the device before its tests should go in the same hook rather than a
 * second one — write a local wrapper around `device.reinstallApp()` for that.
 *
 * **Ordering.** Playwright runs `beforeAll` hooks in registration order, so call this as the
 * first statement in the block, before any `beforeAll` of the block's own that expects a fresh
 * app.
 *
 * **Retries.** A failing test's worker is stopped and the retry runs in a fresh worker process,
 * which re-runs `beforeAll` — so a retry gets a clean device without any bookkeeping. A failure
 * inside a `describe.serial` requeues the whole suite, so the entire block replays from this hook.
 *
 * Unlike the session-level `uninstallAppBeforeTest` / `preserveAppState` capabilities, this
 * resets per block rather than per session, and means the same thing on both platforms.
 */
export function useCleanDevice(options: CleanDeviceOptions = { appReset: 'reinstall' }): void {
  const { appReset } = options;

  test.beforeAll(async ({ device }) => {
    if (appReset === 'reinstall') {
      await device.reinstallApp();
    } else if (appReset === 'clearData') {
      await device.resetAppData();
    }
  });
}

/**
 * Function to extend Playwright’s expect assertion capabilities.
 * This adds a new method `toBeVisible` which checks if an element is visible on the screen.
 * Under `.not`, it waits for the element to be hidden instead, so `expect(el).not.toBeVisible()`
 * returns as soon as the element is gone rather than after the full timeout.
 *
 * @param locator The AppwrightLocator that locates the element on the device screen.
 * @param options
 * @returns
 */
export const expect = test.expect.extend({
  async toBeVisible(this: ExpectMatcherState, locator: AppwrightLocator, options?: ActionOptions) {
    if (this.isNot) {
      let isHidden: boolean;
      try {
        await locator.waitFor('hidden', options);
        isHidden = true;
      } catch (err) {
        if (!(err instanceof TimeoutError)) {
          throw err;
        }
        isHidden = false;
      }
      // `pass` describes the positive assertion; Playwright inverts it for `.not`.
      return {
        message: () => (isHidden ? '' : `Element was still on the screen`),
        pass: !isHidden,
        name: 'toBeVisible',
        expected: false,
        actual: !isHidden,
      };
    }

    const isVisible = await locator.isVisible(options);
    return {
      message: () => (isVisible ? '' : `Element was not found on the screen`),
      pass: isVisible,
      name: 'toBeVisible',
      expected: true,
      actual: isVisible,
    };
  },
});
