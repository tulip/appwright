import { describe, expect, Mock, test, vi } from 'vitest';
//@ts-ignore
import { Client as WebDriverClient } from 'webdriver';

import { Device } from '../device';
import { parseApkBadging } from '../providers/appium';
import { AppState } from '../types';

const readBuildInfo = vi.hoisted(() => vi.fn());
vi.mock('../providers/appium', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/appium')>()),
  readBuildInfo,
}));

type MockClient = WebDriverClient & Record<string, Mock>;

function mockClient(isAndroid: boolean, overrides: Record<string, unknown> = {}): MockClient {
  //@ts-ignore partial mock
  return {
    isAndroid,
    getAppiumContext: vi.fn().mockResolvedValue('NATIVE_APP'),
    switchAppiumContext: vi.fn().mockResolvedValue(undefined),
    executeScript: vi.fn().mockResolvedValue(4),
    ...overrides,
  } as MockClient;
}

function device(client: WebDriverClient, buildPath?: string): Device {
  return new Device(client, 'co.tulip.player', { expectTimeout: 1_000 }, 'emulator', buildPath);
}

describe('getAppState', () => {
  test("passes each driver its argument name and returns the driver's state", async () => {
    const android = mockClient(true);
    expect(await device(android).getAppState()).toBe(AppState.Foreground);
    expect(android.executeScript).toHaveBeenCalledWith('mobile: queryAppState', [
      { appId: 'co.tulip.player' },
    ]);

    const ios = mockClient(false, { executeScript: vi.fn().mockResolvedValue(1) });
    expect(await device(ios).getAppState('com.apple.mobilesafari')).toBe(AppState.NotRunning);
    expect(ios.executeScript).toHaveBeenCalledWith('mobile: queryAppState', [
      { bundleId: 'com.apple.mobilesafari' },
    ]);
  });

  test('asks from NATIVE_APP', async () => {
    const client = mockClient(true, {
      getAppiumContext: vi.fn().mockResolvedValue('WEBVIEW_co.tulip.player'),
    });
    await device(client).getAppState();
    expect(client.switchAppiumContext).toHaveBeenCalledWith('NATIVE_APP');
  });
});

describe('getBuildInfo', () => {
  test("reads the project's build, or the one given", async () => {
    const info = { bundleId: 'co.tulip.player', version: '2.8.0', buildNumber: '2', path: '/b' };
    readBuildInfo.mockResolvedValue(info);
    const d = device(mockClient(false), 'builds/TulipPlayer.app');
    expect(await d.getBuildInfo()).toEqual(info);
    expect(readBuildInfo).toHaveBeenLastCalledWith('builds/TulipPlayer.app');
    await d.getBuildInfo('builds/Other.ipa');
    expect(readBuildInfo).toHaveBeenLastCalledWith('builds/Other.ipa');
  });

  test('needs a build path', async () => {
    await expect(device(mockClient(true)).getBuildInfo()).rejects.toThrow(
      'getBuildInfo() needs a build path',
    );
  });
});

describe('parseApkBadging', () => {
  test("reads the package line's name and versions", () => {
    const badging = [
      "package: name='org.wikipedia' versionCode='50420' versionName='2.7.50420-r-2022-09-12' " +
        "compileSdkVersion='33'",
      "sdkVersion:'21'",
      "launchable-activity: name='org.wikipedia.main.MainActivity'  label='' icon=''",
    ].join('\n');
    expect(parseApkBadging(badging)).toEqual({
      packageName: 'org.wikipedia',
      versionCode: '50420',
      versionName: '2.7.50420-r-2022-09-12',
    });
    expect(parseApkBadging("sdkVersion:'21'")).toEqual({
      packageName: undefined,
      versionCode: undefined,
      versionName: undefined,
    });
  });
});
