import { describe, expect, Mock, test, vi } from 'vitest';
//@ts-ignore
import { Client as WebDriverClient } from 'webdriver';

import { Device } from '../device';

type MockClient = WebDriverClient & Record<string, Mock>;

function mockClient(isAndroid: boolean, overrides: Record<string, unknown> = {}): MockClient {
  //@ts-ignore partial mock
  return {
    isAndroid,
    getAppiumContext: vi.fn().mockResolvedValue('NATIVE_APP'),
    switchAppiumContext: vi.fn().mockResolvedValue(undefined),
    performActions: vi.fn().mockResolvedValue(undefined),
    releaseActions: vi.fn().mockResolvedValue(undefined),
    getWindowRect: vi
      .fn()
      .mockResolvedValue(
        isAndroid
          ? { x: 0, y: 0, width: 1080, height: 2400 }
          : { x: 0, y: 0, width: 402, height: 874 },
      ),
    // A 420 dpi phone: 2.625 physical pixels per dp.
    executeScript: vi
      .fn()
      .mockImplementation(async (command: string) =>
        command === 'mobile: getDisplayDensity' ? 420 : undefined,
      ),
    ...overrides,
  } as MockClient;
}

function device(client: WebDriverClient): Device {
  return new Device(client, 'co.tulip.player', { expectTimeout: 1_000 }, 'emulator');
}

/** The [x, y] of the press and of the lift in the one pointer sequence sent. */
function stroke(client: MockClient): { from: number[]; to: number[]; actions: unknown[] } {
  const [[sequence]] = (client.performActions as Mock).mock.calls[0] as [[{ actions: any[] }]];
  const [press, , , move] = sequence.actions;
  return { from: [press.x, press.y], to: [move.x, move.y], actions: sequence.actions };
}

describe('drag', () => {
  test('one touch pointer: press, hold, move, lift, then release', async () => {
    const client = mockClient(false);
    await device(client).drag({ from: { x: 10.4, y: 20.6 }, to: { x: 300, y: 21 }, duration: 250 });

    expect(client.performActions).toHaveBeenCalledWith([
      {
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: 10, y: 21 },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 100 },
          { type: 'pointerMove', duration: 250, x: 300, y: 21 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
    expect(client.releaseActions).toHaveBeenCalledTimes(1);
  });

  test('switches to NATIVE_APP first', async () => {
    const client = mockClient(true, {
      getAppiumContext: vi.fn().mockResolvedValue('WEBVIEW_co.tulip.player'),
    });
    await device(client).drag({ from: { x: 1, y: 1 }, to: { x: 2, y: 2 } });
    expect(client.switchAppiumContext).toHaveBeenCalledWith('NATIVE_APP');
  });
});

describe('swipeFromEdge', () => {
  test('iOS: the inset is in points, like the window rect', async () => {
    const client = mockClient(false);
    await device(client).swipeFromEdge('right');
    // 2 pt in from x=401, 70% of 402 to the left, at mid-height.
    expect(stroke(client)).toMatchObject({ from: [399, 437], to: [118, 437] });
    expect(client.executeScript).not.toHaveBeenCalled();
  });

  test('Android: the inset is in dp, converted with the display density', async () => {
    const right = mockClient(true);
    await device(right).swipeFromEdge('right', { inset: 2 });
    expect(stroke(right)).toMatchObject({ from: [1074, 1200], to: [318, 1200] });

    const left = mockClient(true);
    await device(left).swipeFromEdge('left', { inset: 4, distance: 0.5, y: 0.25, duration: 600 });
    expect(stroke(left)).toMatchObject({ from: [11, 600], to: [551, 600] });
    expect(stroke(left).actions[3]).toMatchObject({ duration: 600 });
  });

  test('never ends outside the window', async () => {
    const client = mockClient(false);
    await device(client).swipeFromEdge('left', { distance: 2 });
    expect(stroke(client).to[0]).toBe(401);
  });
});

describe('pressBack', () => {
  test('Android: the back key, from NATIVE_APP', async () => {
    const client = mockClient(true, {
      getAppiumContext: vi.fn().mockResolvedValue('WEBVIEW_co.tulip.player'),
    });
    await device(client).pressBack();
    expect(client.switchAppiumContext).toHaveBeenCalledWith('NATIVE_APP');
    expect(client.executeScript).toHaveBeenCalledWith('mobile: pressKey', [{ keycode: 4 }]);
  });

  test('iOS has no back key', async () => {
    await expect(device(mockClient(false)).pressBack()).rejects.toThrow(
      'pressBack() is Android only',
    );
  });
});
