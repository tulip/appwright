import path from 'path';
import { describe, expect, Mock, test, vi } from 'vitest';
//@ts-ignore
import { Client as WebDriverClient } from 'webdriver';

import { Device } from '../device';

type MockClient = WebDriverClient & Record<string, Mock>;

const APP = 'com.example.app';

function mockClient(isAndroid: boolean, overrides: Record<string, unknown> = {}): MockClient {
  //@ts-ignore partial mock
  return {
    isAndroid,
    getAppiumContext: vi.fn().mockResolvedValue('NATIVE_APP'),
    switchAppiumContext: vi.fn().mockResolvedValue(undefined),
    executeScript: vi.fn().mockResolvedValue(undefined),
    removeApp: vi.fn().mockResolvedValue(undefined),
    installApp: vi.fn().mockResolvedValue(undefined),
    isAppInstalled: vi.fn().mockResolvedValue(true),
    pullFile: vi.fn().mockResolvedValue(Buffer.from('hello').toString('base64')),
    ...overrides,
  } as MockClient;
}

function device(client: WebDriverClient, provider = 'emulator', buildPath?: string): Device {
  return new Device(client, APP, { expectTimeout: 1_000 }, provider, buildPath);
}

/** The `mobile:` commands issued, in order, as `[name, args]`. */
function mobileCalls(client: MockClient): [string, unknown][] {
  return (client.executeScript as Mock).mock.calls.map((c: unknown[]) => [
    c[0] as string,
    (c[1] as unknown[] | undefined)?.[0],
  ]);
}

describe('getCurrentBundleId', () => {
  test('hops to NATIVE_APP first when a WebView context is active', async () => {
    const client = mockClient(true, {
      getAppiumContext: vi.fn().mockResolvedValue('WEBVIEW_com.example.app'),
      executeScript: vi.fn().mockResolvedValue('com.android.chrome'),
    });
    expect(await device(client).getCurrentBundleId()).toBe('com.android.chrome');
    expect(client.switchAppiumContext).toHaveBeenCalledWith('NATIVE_APP');
    expect(mobileCalls(client)).toEqual([['mobile: getCurrentPackage', undefined]]);
  });

  test('iOS reads activeAppInfo', async () => {
    const client = mockClient(false, {
      executeScript: vi.fn().mockResolvedValue({ bundleId: 'com.apple.mobilesafari' }),
    });
    expect(await device(client).getCurrentBundleId()).toBe('com.apple.mobilesafari');
  });
});

describe('reinstallApp', () => {
  test('Android: terminate, remove, install with permissions, activate — the app under test', async () => {
    const client = mockClient(true, {
      // A browser is in front: the reinstall must still target the app under test.
      executeScript: vi
        .fn()
        .mockImplementation(async (cmd: string) =>
          cmd === 'mobile: getCurrentPackage' ? 'com.android.chrome' : undefined,
        ),
    });
    await device(client, 'emulator', 'builds/app.apk').reinstallApp();

    expect(client.removeApp).toHaveBeenCalledWith(APP);
    expect(client.installApp).not.toHaveBeenCalled();
    expect(mobileCalls(client)).toEqual([
      ['mobile: terminateApp', { appId: APP }],
      ['mobile: installApp', { appPath: path.resolve('builds/app.apk'), grantPermissions: true }],
      ['mobile: activateApp', { appId: APP }],
    ]);
  });

  test('iOS: uses the portable installApp endpoint and bundleId argument names', async () => {
    const client = mockClient(false);
    await device(client, 'emulator', '/abs/App.app').reinstallApp();

    expect(client.removeApp).toHaveBeenCalledWith(APP);
    expect(client.installApp).toHaveBeenCalledWith('/abs/App.app');
    expect(mobileCalls(client)).toEqual([
      ['mobile: terminateApp', { bundleId: APP }],
      ['mobile: activateApp', { bundleId: APP }],
    ]);
  });

  test('an explicit build path overrides the project one', async () => {
    const client = mockClient(false);
    await device(client, 'local-device', '/abs/App.ipa').reinstallApp('/other/App.ipa');
    expect(client.installApp).toHaveBeenCalledWith('/other/App.ipa');
  });

  test('refuses on cloud providers and without any build path', async () => {
    await expect(device(mockClient(true), 'browserstack', 'a.apk').reinstallApp()).rejects.toThrow(
      "not supported on the 'browserstack' provider",
    );
    await expect(device(mockClient(true), 'emulator').reinstallApp()).rejects.toThrow(
      'needs a build path',
    );
  });
});

describe('resetAppData / clearAppData / grantAllPermissions', () => {
  test('Android: clear, re-grant all permissions, relaunch', async () => {
    const client = mockClient(true);
    await device(client).resetAppData();
    expect(mobileCalls(client)).toEqual([
      ['mobile: terminateApp', { appId: APP }],
      ['mobile: clearApp', { appId: APP }],
      ['mobile: changePermissions', { appPackage: APP, permissions: 'all', action: 'grant' }],
      ['mobile: activateApp', { appId: APP }],
    ]);
  });

  test('iOS simulator: clear by bundleId, no permission step', async () => {
    const client = mockClient(false);
    await device(client).resetAppData();
    expect(mobileCalls(client)).toEqual([
      ['mobile: terminateApp', { bundleId: APP }],
      ['mobile: clearApp', { bundleId: APP }],
      ['mobile: activateApp', { bundleId: APP }],
    ]);
  });

  test('iOS real device: clearAppData is refused with a pointer to reinstallApp', async () => {
    await expect(device(mockClient(false), 'local-device').clearAppData()).rejects.toThrow(
      'Use reinstallApp() instead',
    );
  });

  test('clearAppData and isAppInstalled accept another app', async () => {
    const client = mockClient(true);
    const d = device(client);
    await d.clearAppData('com.android.chrome');
    expect(await d.isAppInstalled('com.android.chrome')).toBe(true);
    expect(mobileCalls(client)).toEqual([['mobile: clearApp', { appId: 'com.android.chrome' }]]);
    expect(client.isAppInstalled).toHaveBeenCalledWith('com.android.chrome');
  });
});

describe('openUrl / waitForAppToClose', () => {
  test('opens with the default handler and returns the app that came to the front', async () => {
    let foreground = APP;
    const client = mockClient(true, {
      executeScript: vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === 'mobile: deepLink') {
          foreground = 'com.android.chrome';
          return undefined;
        }
        if (cmd === 'mobile: getCurrentPackage') {
          return foreground;
        }
        return undefined;
      }),
    });
    expect(await device(client).openUrl('https://example.com')).toBe('com.android.chrome');
    expect(mobileCalls(client)[0]).toEqual(['mobile: deepLink', { url: 'https://example.com' }]);
  });

  test('names the target app per platform', async () => {
    const android = mockClient(true, {
      executeScript: vi
        .fn()
        .mockImplementation(async (cmd: string) =>
          cmd === 'mobile: getCurrentPackage' ? 'com.chrome.beta' : undefined,
        ),
    });
    await device(android).openUrl('https://x', { app: 'com.chrome.beta' });
    expect(mobileCalls(android)[0]).toEqual([
      'mobile: deepLink',
      { url: 'https://x', package: 'com.chrome.beta' },
    ]);

    const ios = mockClient(false, {
      executeScript: vi
        .fn()
        .mockImplementation(async (cmd: string) =>
          cmd === 'mobile: activeAppInfo' ? { bundleId: 'com.apple.mobilesafari' } : undefined,
        ),
    });
    await device(ios).openUrl('https://x', { app: 'com.apple.mobilesafari' });
    expect(mobileCalls(ios)[0]).toEqual([
      'mobile: deepLink',
      { url: 'https://x', bundleId: 'com.apple.mobilesafari' },
    ]);
  });

  test('waitForAppToClose returns once the app leaves the foreground, else throws', async () => {
    const client = mockClient(true, {
      executeScript: vi
        .fn()
        .mockResolvedValueOnce('com.android.chrome')
        .mockResolvedValueOnce('com.android.chrome')
        .mockResolvedValue(APP),
    });
    await device(client).waitForAppToClose('com.android.chrome', { pollInterval: 10 });
    expect(client.executeScript).toHaveBeenCalledTimes(3);

    const stuck = mockClient(true, {
      executeScript: vi.fn().mockResolvedValue('com.android.chrome'),
    });
    await expect(
      device(stuck).waitForAppToClose('com.android.chrome', { timeout: 50, pollInterval: 10 }),
    ).rejects.toThrow('still in the foreground 50ms later');
  });
});

describe('pullFile / waitForFile', () => {
  test('pullFile decodes base64', async () => {
    const client = mockClient(true);
    expect((await device(client).pullFile('/sdcard/Download/a.txt')).toString()).toBe('hello');
    expect(client.pullFile).toHaveBeenCalledWith('/sdcard/Download/a.txt');
  });

  test('waitForFile retries errors and not-ready contents, then reports the last reason', async () => {
    const client = mockClient(true, {
      pullFile: vi
        .fn()
        .mockRejectedValueOnce(new Error('does not exist'))
        .mockResolvedValueOnce(Buffer.from('%PDF-').toString('base64'))
        .mockResolvedValue(Buffer.from('%PDF-...%%EOF').toString('base64')),
    });
    const isReady = (b: Buffer) => b.toString().endsWith('%%EOF');
    const out = await device(client).waitForFile('x.pdf', { pollInterval: 5, isReady });
    expect(out.toString()).toBe('%PDF-...%%EOF');
    expect(client.pullFile).toHaveBeenCalledTimes(3);

    const missing = mockClient(true, { pullFile: vi.fn().mockRejectedValue(new Error('nope')) });
    await expect(
      device(missing).waitForFile('x.pdf', { timeout: 30, pollInterval: 5 }),
    ).rejects.toThrow("Could not pull 'x.pdf' within 30ms: nope");
  });
});
