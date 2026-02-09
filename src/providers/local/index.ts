import { FullProject } from '@playwright/test';

import { Device } from '../../device';
import { logger } from '../../logger';
import {
  AppwrightConfig,
  DeviceProvider,
  LocalDeviceConfig,
  Platform,
  TimeoutOptions,
} from '../../types';
import { validateBuildPath } from '../../utils';
import {
  getActiveAndroidDevices,
  getApkDetails,
  getAppBundleId,
  getConnectedIOSDeviceUDID,
  installDriver,
  startAppiumServer,
} from '../appium';

export class LocalDeviceProvider implements DeviceProvider {
  sessionId?: string;
  private cachedPackageName?: string;

  constructor(private project: FullProject<AppwrightConfig>, appBundleId: string | undefined) {
    if (appBundleId) {
      logger.log(`Bundle id is specified (${appBundleId}) but ignored for local device provider.`);
    }
  }

  async getDevice(): Promise<Device> {
    return await this.createDriver();
  }

  async globalSetup() {
    validateBuildPath(
      this.project.use.buildPath,
      this.project.use.platform == Platform.ANDROID ? '.apk' : '.ipa',
    );

    if (this.project.use.platform == Platform.ANDROID) {
      const androidHome = process.env.ANDROID_HOME;

      if (!androidHome) {
        return Promise.reject(
          'The ANDROID_HOME environment variable is not set. This variable is required to locate your Android SDK. Please set it to the correct path of your Android SDK installation. For detailed instructions on how to set up the Android SDK path, visit: https://developer.android.com/tools',
        );
      }
    }
  }

  private async createDriver(): Promise<Device> {
    await installDriver(
      this.project.use.platform == Platform.ANDROID ? 'uiautomator2' : 'xcuitest',
    );
    await startAppiumServer(this.project.use.device?.provider!);
    const WebDriver = (await import('webdriver')).default;
    const webDriverClient = await WebDriver.newSession(await this.createConfig());
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
    const platformName = this.project.use.platform;
    let appPackageName: string | undefined;
    let appLaunchableActivity: string | undefined;

    if (platformName == Platform.ANDROID) {
      const { packageName, launchableActivity } = await getApkDetails(this.project.use.buildPath!);
      appPackageName = packageName!;
      appLaunchableActivity = launchableActivity!;
      this.cachedPackageName = packageName;
    }
    let udid = (this.project.use.device as LocalDeviceConfig).udid;
    if (!udid) {
      if (platformName == Platform.IOS) {
        udid = await getConnectedIOSDeviceUDID(this.project.use.device?.name);
      } else {
        const activeAndroidDevices = await getActiveAndroidDevices();
        if (activeAndroidDevices > 1) {
          logger.warn(
            `Multiple active devices detected. Selecting one for the test. 
To specify a device, use the udid property. Run "adb devices" to get the UDID for active devices.`,
          );
        }
      }
    }
    return {
      port: 4723,
      capabilities: {
        'appium:deviceName': this.project.use.device?.name,
        'appium:udid': udid,
        'appium:automationName': platformName == Platform.ANDROID ? 'uiautomator2' : 'xcuitest',
        platformName: platformName,
        'appium:autoGrantPermissions': true,
        'appium:app': this.project.use.buildPath,
        'appium:appActivity': appLaunchableActivity,
        'appium:appPackage': appPackageName,
        'appium:autoAcceptAlerts': true,
        'appium:deviceOrientation': this.project.use.device?.orientation,
        'appium:settings[snapshotMaxDepth]': 62,

        'appium:fullReset':
          (this.project.use.device as LocalDeviceConfig).uninstallAppBeforeTest ?? false,
        'appium:noReset': (this.project.use.device as LocalDeviceConfig).preserveAppState ?? true,

        'appium:newCommandTimeout': 300,

        ...(platformName == Platform.IOS && {
          'appium:wdaLaunchTimeout': 600_000,
          'appium:useNewWDA': false,
          'appium:iosInstallPause': 5000,
          ...((this.project.use.device as LocalDeviceConfig).updatedWDABundleId && {
            'appium:updatedWDABundleId': (this.project.use.device as LocalDeviceConfig)
              .updatedWDABundleId,
          }),
        }),

        ...(platformName == Platform.ANDROID && {
          'appium:extractChromeAndroidPackageFromContextName': true,
        }),
      },
    };
  }
}
