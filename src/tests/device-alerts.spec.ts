import { describe, expect, Mock, test, vi } from 'vitest';
//@ts-ignore
import { Client as WebDriverClient } from 'webdriver';

import { Device } from '../device';

type MockClient = WebDriverClient & Record<string, Mock>;

function mockClient(isAndroid: boolean, overrides: Record<string, unknown> = {}): MockClient {
  //@ts-ignore partial mock
  return {
    isAndroid,
    // What every appwright provider creates the session with.
    capabilities: { autoAcceptAlerts: true },
    getAppiumContext: vi.fn().mockResolvedValue('NATIVE_APP'),
    switchAppiumContext: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn().mockResolvedValue(undefined),
    executeScript: vi.fn().mockResolvedValue(undefined),
    getAlertText: vi.fn().mockResolvedValue('Are you sure?\nThis clears the data.'),
    ...overrides,
  } as MockClient;
}

function device(client: WebDriverClient): Device {
  return new Device(client, 'co.tulip.player', { expectTimeout: 1_000 }, 'emulator');
}

const calls = (fn: unknown): unknown[][] => (fn as Mock).mock.calls;

describe('setAlertAutoAccept / withAlertAutoAccept', () => {
  test("iOS: switches WebDriverAgent's defaultAlertAction", async () => {
    const client = mockClient(false);
    const d = device(client);
    await d.setAlertAutoAccept(false);
    await d.setAlertAutoAccept(true);
    expect(calls(client.updateSettings)).toEqual([
      [{ defaultAlertAction: '' }],
      [{ defaultAlertAction: 'accept' }],
    ]);
  });

  test('restores what the session had, read from its capabilities', async () => {
    const client = mockClient(false);
    const result = await device(client).withAlertAutoAccept(false, async () => {
      expect(calls(client.updateSettings)).toEqual([[{ defaultAlertAction: '' }]]);
      return 'answered';
    });
    expect(result).toBe('answered');
    expect(calls(client.updateSettings).at(-1)).toEqual([{ defaultAlertAction: 'accept' }]);
  });

  test('a session without auto-accept, or with auto-dismiss, gets that back', async () => {
    const none = mockClient(false, { capabilities: {} });
    await device(none).withAlertAutoAccept(true, async () => undefined);
    expect(calls(none.updateSettings)).toEqual([
      [{ defaultAlertAction: 'accept' }],
      [{ defaultAlertAction: '' }],
    ]);

    const dismissing = mockClient(false, { capabilities: { 'appium:autoDismissAlerts': true } });
    await device(dismissing).withAlertAutoAccept(false, async () => undefined);
    expect(calls(dismissing.updateSettings).at(-1)).toEqual([{ defaultAlertAction: 'dismiss' }]);
  });

  test("restores the value an earlier setAlertAutoAccept() left, not the capability's", async () => {
    const client = mockClient(false);
    const d = device(client);
    await d.setAlertAutoAccept(false);
    await d.withAlertAutoAccept(true, async () => undefined);
    expect(calls(client.updateSettings).at(-1)).toEqual([{ defaultAlertAction: '' }]);
  });

  test("fn's error is the one reported when the restore fails too", async () => {
    const client = mockClient(false, {
      updateSettings: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('session gone')),
    });
    await expect(
      device(client).withAlertAutoAccept(false, async () => {
        throw new Error('the alert never showed');
      }),
    ).rejects.toThrow('the alert never showed');
    expect(client.updateSettings).toHaveBeenCalledTimes(2);
  });

  test('a restore that fails after fn passed is reported', async () => {
    const client = mockClient(false, {
      updateSettings: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('session gone')),
    });
    await expect(device(client).withAlertAutoAccept(false, async () => 'ok')).rejects.toThrow(
      'session gone',
    );
  });

  test('Android: nothing to switch, fn still runs', async () => {
    const client = mockClient(true);
    expect(await device(client).withAlertAutoAccept(false, async () => 42)).toBe(42);
    expect(client.updateSettings).not.toHaveBeenCalled();
  });
});

describe('acceptAlert / dismissAlert / getAlertText', () => {
  test('iOS answers through mobile: alert', async () => {
    const client = mockClient(false);
    const d = device(client);
    await d.acceptAlert();
    await d.dismissAlert({ buttonLabel: 'Cancel' });
    expect(calls(client.executeScript)).toEqual([
      ['mobile: alert', [{ action: 'accept' }]],
      ['mobile: alert', [{ action: 'dismiss', buttonLabel: 'Cancel' }]],
    ]);
  });

  test("Android answers through UiAutomator2's alert extensions", async () => {
    const client = mockClient(true);
    const d = device(client);
    await d.acceptAlert({ buttonLabel: 'Clear Data' });
    await d.dismissAlert();
    expect(calls(client.executeScript)).toEqual([
      ['mobile: acceptAlert', [{ buttonLabel: 'Clear Data' }]],
      ['mobile: dismissAlert', [{}]],
    ]);
  });

  test('getAlertText reads the native alert, from NATIVE_APP', async () => {
    const client = mockClient(true, {
      getAppiumContext: vi.fn().mockResolvedValue('WEBVIEW_co.tulip.player'),
    });
    expect(await device(client).getAlertText()).toBe('Are you sure?\nThis clears the data.');
    expect(client.switchAppiumContext).toHaveBeenCalledWith('NATIVE_APP');
  });
});
