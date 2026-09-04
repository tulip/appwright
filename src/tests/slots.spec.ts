import { afterEach, describe, expect, test } from 'vitest';

import {
  APPIUM_PORT_ENV,
  emulatorPortFromUdid,
  getAppiumPort,
  getDeviceEntryForSlot,
  getSlotCapabilities,
  resolveDeviceEntries,
} from '../providers/slots';
import { Platform } from '../types';

describe('getSlotCapabilities', () => {
  test('android: only systemPort, offset by slot', () => {
    expect(getSlotCapabilities(Platform.ANDROID, 0)).toEqual({ 'appium:systemPort': 8200 });
    expect(getSlotCapabilities(Platform.ANDROID, 3)).toEqual({ 'appium:systemPort': 8203 });
  });

  test('android: chromedriverPort and mjpegServerPort are left unset', () => {
    const caps = getSlotCapabilities(Platform.ANDROID, 1);
    expect(caps).not.toHaveProperty('appium:chromedriverPort');
    expect(caps).not.toHaveProperty('appium:mjpegServerPort');
    expect(Object.keys(caps)).toEqual(['appium:systemPort']);
  });

  test('ios: wdaLocalPort, mjpegServerPort and derivedDataPath per slot', () => {
    const caps = getSlotCapabilities(Platform.IOS, 2);
    expect(caps['appium:wdaLocalPort']).toBe(8102);
    expect(caps['appium:mjpegServerPort']).toBe(9102);
    expect(String(caps['appium:derivedDataPath'])).toContain('slot-2');
    expect(Object.keys(caps).sort()).toEqual([
      'appium:derivedDataPath',
      'appium:mjpegServerPort',
      'appium:wdaLocalPort',
    ]);
  });

  test('ios: slot 0 and slot 1 get distinct values for every capability', () => {
    const slot0 = getSlotCapabilities(Platform.IOS, 0);
    const slot1 = getSlotCapabilities(Platform.IOS, 1);
    expect(slot0['appium:wdaLocalPort']).toBe(8100);
    expect(slot1['appium:wdaLocalPort']).toBe(8101);
    expect(slot0['appium:mjpegServerPort']).toBe(9100);
    expect(slot1['appium:mjpegServerPort']).toBe(9101);
    expect(slot0['appium:derivedDataPath']).not.toBe(slot1['appium:derivedDataPath']);
    expect(String(slot0['appium:derivedDataPath'])).toContain('slot-0');
    expect(String(slot1['appium:derivedDataPath'])).toContain('slot-1');
  });

  test('negative slot throws', () => {
    expect(() => getSlotCapabilities(Platform.ANDROID, -1)).toThrow(/non-negative/);
    expect(() => getSlotCapabilities(Platform.IOS, -1)).toThrow(/non-negative/);
  });
});

describe('resolveDeviceEntries', () => {
  test('devices list wins over udid', () => {
    const entries = resolveDeviceEntries({
      udid: 'ignored',
      devices: [{ udid: 'a' }, { udid: 'b', avd: 'Pixel' }],
    });
    expect(entries).toEqual([{ udid: 'a' }, { udid: 'b', avd: 'Pixel' }]);
  });

  test('udid alone becomes a single entry', () => {
    expect(resolveDeviceEntries({ udid: 'emulator-5554' })).toEqual([{ udid: 'emulator-5554' }]);
  });

  test('neither udid nor devices gives an empty list', () => {
    expect(resolveDeviceEntries({})).toEqual([]);
    expect(resolveDeviceEntries({ devices: [] })).toEqual([]);
  });

  test('duplicate udid throws', () => {
    expect(() => resolveDeviceEntries({ devices: [{ udid: 'a' }, { udid: 'a' }] })).toThrow(
      /Duplicate udid "a"/,
    );
  });

  test('entry without udid throws', () => {
    expect(() => resolveDeviceEntries({ devices: [{ udid: '' }] })).toThrow(/must have a `udid`/);
  });
});

describe('getDeviceEntryForSlot', () => {
  test('legacy config (no devices): slot 0 is undefined so the provider auto-picks', () => {
    expect(getDeviceEntryForSlot({}, 0)).toBeUndefined();
  });

  test('legacy config (no devices): slot 1 throws and points at `devices`', () => {
    expect(() => getDeviceEntryForSlot({}, 1)).toThrow(/devices/);
  });

  test('with two devices: slot 1 is the second entry', () => {
    const device = { devices: [{ udid: 'first' }, { udid: 'second' }] };
    expect(getDeviceEntryForSlot(device, 0)).toEqual({ udid: 'first' });
    expect(getDeviceEntryForSlot(device, 1)).toEqual({ udid: 'second' });
  });

  test('with two devices: slot 2 throws', () => {
    const device = { devices: [{ udid: 'first' }, { udid: 'second' }] };
    expect(() => getDeviceEntryForSlot(device, 2)).toThrow(/only 2 device\(s\) configured/);
  });

  test('single udid shorthand: slot 0 resolves, slot 1 throws', () => {
    expect(getDeviceEntryForSlot({ udid: 'x' }, 0)).toEqual({ udid: 'x' });
    expect(() => getDeviceEntryForSlot({ udid: 'x' }, 1)).toThrow(/only 1 device\(s\) configured/);
  });

  test('negative slot throws', () => {
    expect(() => getDeviceEntryForSlot({ udid: 'x' }, -1)).toThrow(/non-negative/);
  });
});

describe('emulatorPortFromUdid', () => {
  test('parses even ports in range', () => {
    expect(emulatorPortFromUdid('emulator-5554')).toBe(5554);
    expect(emulatorPortFromUdid('emulator-5556')).toBe(5556);
    expect(emulatorPortFromUdid('emulator-5584')).toBe(5584);
  });

  test('odd port throws', () => {
    expect(() => emulatorPortFromUdid('emulator-5555')).toThrow(/Invalid emulator udid/);
  });

  test('port above range throws', () => {
    expect(() => emulatorPortFromUdid('emulator-5586')).toThrow(/Invalid emulator udid/);
  });

  test('port below range throws', () => {
    expect(() => emulatorPortFromUdid('emulator-5552')).toThrow(/Invalid emulator udid/);
  });

  test('physical device serial throws', () => {
    expect(() => emulatorPortFromUdid('R58M12345')).toThrow(/Invalid emulator udid/);
  });
});

describe('getAppiumPort', () => {
  const original = process.env[APPIUM_PORT_ENV];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[APPIUM_PORT_ENV];
    } else {
      process.env[APPIUM_PORT_ENV] = original;
    }
  });

  test('reads the port from the environment', () => {
    process.env[APPIUM_PORT_ENV] = '4725';
    expect(getAppiumPort()).toBe(4725);
  });

  test('throws when unset', () => {
    delete process.env[APPIUM_PORT_ENV];
    expect(() => getAppiumPort()).toThrow(/Appium server port not found/);
  });

  test('throws when not a number', () => {
    process.env[APPIUM_PORT_ENV] = 'abc';
    expect(() => getAppiumPort()).toThrow(/Appium server port not found/);
  });
});
