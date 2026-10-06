import { beforeEach, describe, expect, Mock, test, vi } from 'vitest';
//@ts-ignore
import { Client as WebDriverClient } from 'webdriver';

import { Device } from '../device';

/** `execFile` as `promisify` sees it: the last argument is the callback. */
const execFile = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile,
}));

type MockClient = WebDriverClient & Record<string, Mock>;

const APP = 'com.example.app';
const SIM_UDID = '09E70ECA-F05D-4335-A840-B8B021CDE458';

function mockClient(isAndroid: boolean, overrides: Record<string, unknown> = {}): MockClient {
  //@ts-ignore partial mock
  return {
    isAndroid,
    capabilities: isAndroid ? { deviceUDID: 'emulator-5556' } : { udid: SIM_UDID },
    getAppiumContext: vi.fn().mockResolvedValue('NATIVE_APP'),
    switchAppiumContext: vi.fn().mockResolvedValue(undefined),
    executeScript: vi.fn().mockResolvedValue(undefined),
    getPageSource: vi.fn().mockResolvedValue('<hierarchy/>'),
    ...overrides,
  } as MockClient;
}

function device(client: WebDriverClient, provider = 'emulator'): Device {
  return new Device(client, APP, { expectTimeout: 1_000 }, provider);
}

/** Makes the next `execFile` call succeed with `stdout`, or fail with `stderr`. */
function execFileResult({ stdout = '', stderr }: { stdout?: string; stderr?: string }) {
  execFile.mockImplementationOnce((...args: unknown[]) => {
    const callback = args[args.length - 1] as (error: unknown, result?: unknown) => void;
    if (stderr != null) {
      callback(Object.assign(new Error('Command failed'), { stderr }));
    } else {
      callback(null, { stdout, stderr: '' });
    }
  });
}

beforeEach(() => {
  execFile.mockReset();
});

describe('getUdid', () => {
  test('reads the device each driver reports it landed on', () => {
    expect(device(mockClient(true)).getUdid()).toBe('emulator-5556');
    expect(device(mockClient(false)).getUdid()).toBe(SIM_UDID);
  });

  test("prefers UiAutomator2's deviceUDID over the requested udid", () => {
    const client = mockClient(true, {
      capabilities: { udid: 'emulator-5554', deviceUDID: 'emulator-5556' },
    });
    expect(device(client).getUdid()).toBe('emulator-5556');
  });

  test('throws when the capabilities carry none', () => {
    const client = mockClient(false, { capabilities: { platformName: 'iOS' } });
    expect(() => device(client, 'browserstack').getUdid()).toThrow('reported no udid');
  });
});

describe('isSimulator', () => {
  test('only an iOS device from the emulator provider is a simulator', () => {
    expect(device(mockClient(false), 'emulator').isSimulator()).toBe(true);
    expect(device(mockClient(false), 'local-device').isSimulator()).toBe(false);
    expect(device(mockClient(true), 'emulator').isSimulator()).toBe(false);
  });
});

describe('getPageSource', () => {
  test('reads from NATIVE_APP and switches back to the WebView', async () => {
    const client = mockClient(true, {
      getAppiumContext: vi.fn().mockResolvedValue('WEBVIEW_com.example.app'),
    });
    expect(await device(client).getPageSource()).toBe('<hierarchy/>');
    expect(calls(client.switchAppiumContext)).toEqual([
      ['NATIVE_APP'],
      ['WEBVIEW_com.example.app'],
    ]);
  });

  test('does not switch at all from NATIVE_APP', async () => {
    const client = mockClient(false);
    await device(client).getPageSource();
    expect(client.switchAppiumContext).not.toHaveBeenCalled();
  });

  test('still returns the source when the WebView cannot be restored', async () => {
    const client = mockClient(true, {
      getAppiumContext: vi.fn().mockResolvedValue('WEBVIEW_com.example.app'),
      switchAppiumContext: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(new Error('no such context')),
    });
    expect(await device(client).getPageSource()).toBe('<hierarchy/>');
  });

  test('reads the name of a context reported as an object', async () => {
    const client = mockClient(true, {
      getAppiumContext: vi.fn().mockResolvedValue({ id: 'WEBVIEW_1', title: 'Login' }),
    });
    await device(client).getPageSource();
    expect(calls(client.switchAppiumContext)).toEqual([['NATIVE_APP'], ['WEBVIEW_1']]);
  });
});

describe('switchToWindow / getUrl', () => {
  test('delegate to the session', async () => {
    const client = mockClient(true, {
      switchToWindow: vi.fn().mockResolvedValue(undefined),
      getUrl: vi.fn().mockResolvedValue('https://example.com/a'),
    });
    const d = device(client);
    await d.switchToWindow('CDwindow-1');
    expect(client.switchToWindow).toHaveBeenCalledWith('CDwindow-1');
    expect(await d.getUrl()).toBe('https://example.com/a');
  });
});

describe('terminateApp({ force: true })', () => {
  test('iOS simulator: simctl terminate on the session udid, not WebDriverAgent', async () => {
    execFileResult({});
    const client = mockClient(false);
    await device(client).terminateApp('com.apple.SafariViewService', { force: true });
    expect(execFile.mock.calls[0]!.slice(0, 2)).toEqual([
      'xcrun',
      ['simctl', 'terminate', SIM_UDID, 'com.apple.SafariViewService'],
    ]);
    expect(client.executeScript).not.toHaveBeenCalled();
  });

  test('an app that is not running is not an error; anything else is', async () => {
    execFileResult({
      stderr: 'Simulator device failed to terminate x.\nfound nothing to terminate',
    });
    await device(mockClient(false)).terminateApp('x', { force: true });

    execFileResult({ stderr: 'Invalid device: nope' });
    await expect(device(mockClient(false)).terminateApp('x', { force: true })).rejects.toThrow(
      'Invalid device: nope',
    );
  });

  test('a physical iOS device is refused; Android terminates as usual', async () => {
    await expect(
      device(mockClient(false), 'local-device').terminateApp('x', { force: true }),
    ).rejects.toThrow(
      "needs an iOS simulator, which `xcrun simctl` can reach; this is a 'local-device' iOS device",
    );

    const android = mockClient(true);
    await device(android).terminateApp('com.android.chrome', { force: true });
    expect(android.executeScript).toHaveBeenCalledWith('mobile: terminateApp', [
      { appId: 'com.android.chrome' },
    ]);
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('simulatorContainerPath', () => {
  test("joins the relative path onto the app's data container", async () => {
    execFileResult({ stdout: '/Users/me/Library/Developer/CoreSimulator/Devices/X/data/App\n' });
    expect(await device(mockClient(false)).simulatorContainerPath('/Library/Caches/out.pdf')).toBe(
      '/Users/me/Library/Developer/CoreSimulator/Devices/X/data/App/Library/Caches/out.pdf',
    );
    expect(execFile.mock.calls[0]!.slice(0, 2)).toEqual([
      'xcrun',
      ['simctl', 'get_app_container', SIM_UDID, APP, 'data'],
    ]);
  });

  test('is refused on Android and reports a missing container', async () => {
    await expect(device(mockClient(true)).simulatorContainerPath()).rejects.toThrow(
      'this is an Android device',
    );
    execFileResult({ stderr: 'No such file or directory' });
    await expect(device(mockClient(false)).simulatorContainerPath()).rejects.toThrow(
      `Could not locate the data container of '${APP}' on simulator ${SIM_UDID}`,
    );
  });
});

function calls(fn: unknown): unknown[][] {
  return (fn as Mock).mock.calls;
}
