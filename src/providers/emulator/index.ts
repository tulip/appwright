import { FullProject } from '@playwright/test';

import { Device } from '../../device';
import { logger } from '../../logger';
import {
  AppwrightConfig,
  DeviceProvider,
  EmulatorConfig,
  Platform,
  TimeoutOptions,
} from '../../types';
import { validateBuildPath } from '../../utils';
import { getApkDetails, getAppBundleId, isAppiumHealthy } from '../appium';
import {
  getAppiumPort,
  getDeviceEntryForSlot,
  getSlotCapabilities,
  resolveDeviceEntries,
} from '../slots';
import { ensureEmulatorsBooted, isDeviceOnline, listAvds } from './boot';

export class EmulatorProvider implements DeviceProvider {
  sessionId?: string;
  private cachedPackageName?: string;

  constructor(
    private project: FullProject<AppwrightConfig>,
    appBundleId: string | undefined,
    private slot: number = 0,
  ) {
    if (appBundleId) {
      logger.log(`Bundle id is specified (${appBundleId}) but ignored for Emulator provider.`);
    }
  }

  async getDevice(): Promise<Device> {
    return await this.createDriver();
  }

  async globalSetup(options?: { workers: number }) {
    const platform = this.project.use.platform!;
    const deviceConfig = this.project.use.device as EmulatorConfig;

    validateBuildPath(this.project.use.buildPath, platform == Platform.ANDROID ? '.apk' : '.app');

    if (platform == Platform.ANDROID) {
      const androidHome = process.env.ANDROID_HOME;
      const androidSimulatorConfigDocLink =
        'https://github.com/empirical-run/appwright/blob/main/docs/config.md#android-emulator';
      if (!androidHome) {
        throw new Error(
          `The ANDROID_HOME environment variable is not set.
This variable is required to locate your Android SDK.
Please set it to the correct path of your Android SDK installation.
Follow the steps mentioned in ${androidSimulatorConfigDocLink} to run test on Android emulator.`,
        );
      }

      const javaHome = process.env.JAVA_HOME;
      if (!javaHome) {
        throw new Error(
          `The JAVA_HOME environment variable is not set.
Follow the steps mentioned in ${androidSimulatorConfigDocLink} to run test on Android emulator.`,
        );
      }

      // Throws with installation guidance when no AVDs exist.
      await listAvds();
    }

    // Boot one emulator/simulator per worker slot. With no `devices`/`udid` configured this is
    // empty and the Appium driver picks a running emulator itself (legacy behaviour).
    const entries = resolveDeviceEntries(deviceConfig).slice(0, options?.workers ?? 1);

    if (platform == Platform.ANDROID) {
      for (const entry of entries) {
        if (!entry.avd && !(await isDeviceOnline(platform, entry.udid))) {
          throw new Error(
            `Emulator "${entry.udid}" is not running and has no \`avd\` configured, so Appwright ` +
              'cannot boot it. Either add `avd: "<name>"` to this entry in `device.devices` ' +
              '(see `emulator -list-avds`) or boot the emulator manually before running tests.',
          );
        }
      }
    }

    if (entries.length > 0) {
      await ensureEmulatorsBooted(platform, entries);
    }
  }

  private async createDriver(): Promise<Device> {
    const config = await this.createConfig();
    if (!(await isAppiumHealthy(config.port))) {
      throw new Error(
        `Appium server on port ${config.port} is not responding. The shared server started by ` +
          'globalSetup may have crashed; check the Appium logs above.',
      );
    }
    const WebDriver = (await import('webdriver')).default;
    const webDriverClient = await WebDriver.newSession(config);
    this.sessionId = webDriverClient.sessionId;

    let bundleId: string;
    if (this.project.use.platform == Platform.ANDROID) {
      bundleId = this.cachedPackageName!;
    } else {
      bundleId = await getAppBundleId(this.project.use.buildPath!);
    }

    const expectTimeout = this.project.use.expectTimeout!;
    const testOptions: TimeoutOptions = {
      expectTimeout,
    };
    return new Device(webDriverClient, bundleId, testOptions, this.project.use.device?.provider!);
  }

  private async createConfig() {
    const platformName = this.project.use.platform!;
    const deviceConfig = this.project.use.device as EmulatorConfig;
    let appPackageName: string | undefined;
    let appLaunchableActivity: string | undefined;

    if (platformName == Platform.ANDROID) {
      const { packageName, launchableActivity } = await getApkDetails(this.project.use.buildPath!);
      appPackageName = packageName!;
      appLaunchableActivity = launchableActivity!;
      this.cachedPackageName = packageName;
    }

    // Device for this worker slot. `undefined` only when nothing is configured and slot is 0
    // (legacy behaviour: no udid is passed and the Appium driver picks a running emulator).
    const entry = getDeviceEntryForSlot(deviceConfig, this.slot);
    const udid = entry?.udid;

    return {
      port: getAppiumPort(),
      capabilities: {
        'appium:deviceName': this.project.use.device?.name,
        'appium:udid': udid,
        'appium:automationName': platformName == Platform.ANDROID ? 'uiautomator2' : 'xcuitest',
        'appium:platformVersion': deviceConfig.osVersion,
        'appium:appActivity': appLaunchableActivity,
        'appium:appPackage': appPackageName,
        platformName: platformName,
        'appium:autoGrantPermissions': true,
        'appium:app': this.project.use.buildPath,
        'appium:autoAcceptAlerts': true,
        'appium:deviceOrientation': this.project.use.device?.orientation,
        'appium:settings[snapshotMaxDepth]': 62,

        'appium:fullReset': deviceConfig.uninstallAppBeforeTest ?? false,
        'appium:noReset': deviceConfig.preserveAppState ?? true,

        'appium:newCommandTimeout': 300,

        // Ports/paths that must be unique per concurrent session on this host.
        ...getSlotCapabilities(platformName, this.slot),

        ...(platformName == Platform.IOS && {
          'appium:wdaLaunchTimeout': 600_000,
          'appium:useNewWDA': false,
          'appium:iosInstallPause': 5000,
        }),

        ...(platformName == Platform.ANDROID && {
          'appium:extractChromeAndroidPackageFromContextName': true,
        }),
      },
    };
  }
}
