import { afterEach, describe, expect, Mock, test, vi } from 'vitest';
//@ts-ignore
import { Client as WebDriverClient } from 'webdriver';

import { Device } from '../device';
import { DeviceOrientation } from '../types';

type MockClient = WebDriverClient & Record<string, Mock>;

const APP = 'co.tulip.player';
const PORTRAIT = { x: 0, y: 0, width: 402, height: 874 };
const LANDSCAPE = { x: 0, y: 0, width: 874, height: 402 };

function mockClient(isAndroid: boolean, overrides: Record<string, unknown> = {}): MockClient {
  //@ts-ignore partial mock
  return {
    isAndroid,
    getAppiumContext: vi.fn().mockResolvedValue('NATIVE_APP'),
    switchAppiumContext: vi.fn().mockResolvedValue(undefined),
    setOrientation: vi.fn().mockResolvedValue(undefined),
    getOrientation: vi.fn().mockResolvedValue('LANDSCAPE'),
    getWindowRect: vi.fn().mockResolvedValue(LANDSCAPE),
    executeScript: vi
      .fn()
      .mockImplementation(async (command: string) =>
        command === 'mobile: activeAppInfo' ? { bundleId: APP } : undefined,
      ),
    ...overrides,
  } as MockClient;
}

function device(client: WebDriverClient): Device {
  return new Device(client, APP, { expectTimeout: 1_000 }, 'emulator');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('setOrientation', () => {
  test('rotates, then waits until the driver and the window shape agree', async () => {
    const client = mockClient(false, {
      // The driver flips first; the window takes its new shape a beat later.
      getOrientation: vi.fn().mockResolvedValueOnce('PORTRAIT').mockResolvedValue('LANDSCAPE'),
      getWindowRect: vi
        .fn()
        .mockResolvedValueOnce(PORTRAIT)
        .mockResolvedValueOnce(PORTRAIT)
        .mockResolvedValue({ ...LANDSCAPE, extra: true }),
    });
    vi.useFakeTimers();
    const rotated = device(client).setOrientation(DeviceOrientation.LANDSCAPE);
    await vi.runAllTimersAsync();

    expect(await rotated).toEqual(LANDSCAPE);
    expect(client.setOrientation).toHaveBeenCalledWith('LANDSCAPE');
    expect(client.getWindowRect).toHaveBeenCalledTimes(3);
  });

  test('times out naming what the driver and the window say', async () => {
    const client = mockClient(false, {
      getOrientation: vi.fn().mockResolvedValue('PORTRAIT'),
      getWindowRect: vi.fn().mockResolvedValue(PORTRAIT),
    });
    await expect(
      device(client).setOrientation(DeviceOrientation.LANDSCAPE, { timeout: 0 }),
    ).rejects.toThrow(
      'setOrientation(landscape): the device did not settle within 0ms. The driver reports ' +
        'portrait and the window is 402x874.',
    );
  });

  test("explains WebDriverAgent's refusal instead of retrying it", async () => {
    const client = mockClient(false, {
      setOrientation: vi
        .fn()
        .mockRejectedValue(new Error('Unable To Rotate Device when running "orientation"')),
    });
    await expect(device(client).setOrientation(DeviceOrientation.LANDSCAPE)).rejects.toThrow(
      'the app under test has to be in front (the home screen is portrait-only)',
    );
    expect(client.setOrientation).toHaveBeenCalledTimes(1);

    const other = mockClient(true, {
      setOrientation: vi.fn().mockRejectedValue(new Error('invalid session id')),
    });
    await expect(device(other).setOrientation(DeviceOrientation.PORTRAIT)).rejects.toThrow(
      /^invalid session id$/,
    );
  });

  test('switches to NATIVE_APP first', async () => {
    const client = mockClient(true, {
      getAppiumContext: vi.fn().mockResolvedValue('WEBVIEW_co.tulip.player'),
    });
    await device(client).getOrientation();
    expect(client.switchAppiumContext).toHaveBeenCalledWith('NATIVE_APP');
  });
});

describe('getOrientation / getWindowRect', () => {
  test("normalise the driver's answer", async () => {
    const client = mockClient(true, {
      getOrientation: vi.fn().mockResolvedValueOnce('PORTRAIT').mockResolvedValue('landscape'),
      getWindowRect: vi.fn().mockResolvedValue({ ...PORTRAIT, extra: 1 }),
    });
    const d = device(client);
    expect(await d.getOrientation()).toBe(DeviceOrientation.PORTRAIT);
    expect(await d.getOrientation()).toBe(DeviceOrientation.LANDSCAPE);
    expect(await d.getWindowRect()).toEqual(PORTRAIT);

    const odd = mockClient(true, { getOrientation: vi.fn().mockResolvedValue('UPSIDE') });
    await expect(device(odd).getOrientation()).rejects.toThrow('"UPSIDE"');
  });
});

describe('restoreOrientation (after each test)', () => {
  test('does nothing when the test did not rotate', async () => {
    const client = mockClient(false);
    await device(client).restoreOrientation(DeviceOrientation.PORTRAIT);
    expect(client.setOrientation).not.toHaveBeenCalled();
  });

  test('brings the app to the front, then rotates back to the configured orientation', async () => {
    let foreground = APP;
    const orientations = ['LANDSCAPE', 'PORTRAIT'];
    const client = mockClient(false, {
      getOrientation: vi.fn().mockImplementation(async () => orientations[0]),
      getWindowRect: vi
        .fn()
        .mockImplementation(async () => (orientations[0] === 'PORTRAIT' ? PORTRAIT : LANDSCAPE)),
      setOrientation: vi.fn().mockImplementation(async (value: string) => {
        orientations[0] = value;
      }),
      executeScript: vi.fn().mockImplementation(async (command: string) => {
        if (command === 'mobile: activeAppInfo') {
          return { bundleId: foreground };
        }
        if (command === 'mobile: activateApp') {
          foreground = APP;
        }
        return undefined;
      }),
    });
    const d = device(client);
    await d.setOrientation(DeviceOrientation.LANDSCAPE);
    foreground = 'com.apple.springboard';

    await d.restoreOrientation(DeviceOrientation.PORTRAIT);

    expect(client.executeScript).toHaveBeenCalledWith('mobile: activateApp', [{ bundleId: APP }]);
    expect((client.setOrientation as Mock).mock.calls).toEqual([['LANDSCAPE'], ['PORTRAIT']]);
  });

  test('a failed restore is logged, never thrown', async () => {
    const client = mockClient(false);
    const d = device(client);
    await d.setOrientation(DeviceOrientation.LANDSCAPE);
    (client.setOrientation as Mock).mockRejectedValue(new Error('invalid session id'));
    await expect(d.restoreOrientation(DeviceOrientation.PORTRAIT)).resolves.toBeUndefined();
  });
});
