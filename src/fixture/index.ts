import {
  FullProject,
  test as base,
} from '@playwright/test';

import { Device } from '../device';
import { createDeviceProvider } from '../providers';
import { stopAppiumServer } from '../providers/appium';
import {
  ActionOptions,
  AppwrightConfig,
  AppwrightLocator,
  DeviceProvider,
  Platform,
} from '../types';
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
    const deviceProvider = createDeviceProvider(testInfo.project);
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
    if (deviceProviderName === 'emulator' || deviceProviderName === 'local-device') {
      await stopAppiumServer();
    }
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
      const { project, workerIndex } = workerInfo;
      const beforeSession = new Date();
      const deviceProvider = createDeviceProvider(project);
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
 * Function to extend Playwright’s expect assertion capabilities.
 * This adds a new method `toBeVisible` which checks if an element is visible on the screen.
 *
 * @param locator The AppwrightLocator that locates the element on the device screen.
 * @param options
 * @returns
 */
export const expect = test.expect.extend({
  toBeVisible: async (locator: AppwrightLocator, options?: ActionOptions) => {
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
