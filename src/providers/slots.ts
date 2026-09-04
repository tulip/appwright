import os from 'os';
import path from 'path';

import {
  DeviceEntry,
  EmulatorConfig,
  LocalDeviceConfig,
  Platform,
} from '../types';

/**
 * Environment variable through which globalSetup tells worker processes which port the
 * shared Appium server listens on.
 */
export const APPIUM_PORT_ENV = 'APPWRIGHT_APPIUM_PORT';

const ANDROID_SYSTEM_PORT_BASE = 8200;
const IOS_WDA_LOCAL_PORT_BASE = 8100;
const IOS_MJPEG_SERVER_PORT_BASE = 9100;

const EMULATOR_UDID_PATTERN = /^emulator-(\d+)$/;
const EMULATOR_MIN_PORT = 5554;
const EMULATOR_MAX_PORT = 5584;

type SlotDeviceConfig = Pick<LocalDeviceConfig | EmulatorConfig, 'udid' | 'devices'>;

/**
 * Appium capabilities that must be unique for every concurrent session on one host.
 * Spread the result into the session capabilities.
 *
 * - Android: `appium:systemPort` (uiautomator2 server forward). `chromedriverPort` and
 *   `mjpegServerPort` are deliberately left unset: the driver auto-allocates chromedriver ports
 *   and skips the MJPEG forward when the capability is absent.
 * - iOS: `appium:wdaLocalPort` (WDA forward), `appium:mjpegServerPort` (XCUITest binds it on
 *   every session, so it must be unique once set) and `appium:derivedDataPath` (per-instance
 *   WDA build products, as recommended by the XCUITest parallel-tests guide).
 */
export function getSlotCapabilities(
  platform: Platform,
  slot: number,
): Record<string, string | number> {
  assertValidSlot(slot);
  if (platform === Platform.ANDROID) {
    return {
      'appium:systemPort': ANDROID_SYSTEM_PORT_BASE + slot,
    };
  }
  return {
    'appium:wdaLocalPort': IOS_WDA_LOCAL_PORT_BASE + slot,
    'appium:mjpegServerPort': IOS_MJPEG_SERVER_PORT_BASE + slot,
    'appium:derivedDataPath': path.join(os.tmpdir(), 'appwright-wda', `slot-${slot}`),
  };
}

/**
 * Normalises the device configuration into an ordered list of device entries.
 * `devices` wins; otherwise a single `udid` becomes a one-entry list; otherwise the list is
 * empty (legacy behaviour: the provider auto-picks a device for slot 0).
 */
export function resolveDeviceEntries(device: SlotDeviceConfig): DeviceEntry[] {
  let entries: DeviceEntry[];
  if (device.devices && device.devices.length > 0) {
    entries = device.devices;
  } else if (device.udid) {
    entries = [{ udid: device.udid }];
  } else {
    entries = [];
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.udid) {
      throw new Error('Every entry in `device.devices` must have a `udid`.');
    }
    if (seen.has(entry.udid)) {
      throw new Error(`Duplicate udid "${entry.udid}" in \`device.devices\`.`);
    }
    seen.add(entry.udid);
  }
  return entries;
}

/**
 * Returns the device entry a worker slot should use.
 *
 * - With configured entries: `entries[slot]`, or throws if the slot is out of range.
 * - Without configured entries: `undefined` for slot 0 (legacy auto-pick), throws for any other
 *   slot because more than one worker cannot share an unnamed device.
 */
export function getDeviceEntryForSlot(
  device: SlotDeviceConfig,
  slot: number,
): DeviceEntry | undefined {
  assertValidSlot(slot);
  const entries = resolveDeviceEntries(device);
  if (entries.length === 0) {
    if (slot === 0) {
      return undefined;
    }
    throw new Error(
      `Worker slot ${slot} has no device. Running more than one worker requires listing the ` +
        'devices in the config, e.g. `device: { devices: [{ udid: "..." }, { udid: "..." }] }`, ' +
        'or set `workers: 1`.',
    );
  }
  const entry = entries[slot];
  if (!entry) {
    throw new Error(
      `Worker slot ${slot} has no device: only ${entries.length} device(s) configured in ` +
        '`device.devices`. Add more entries or lower `workers`.',
    );
  }
  return entry;
}

/**
 * Extracts the console port from an Android emulator serial such as `emulator-5554`.
 * The emulator binary documents even ports in the range 5554..5584.
 */
export function emulatorPortFromUdid(udid: string): number {
  const match = udid.match(EMULATOR_UDID_PATTERN);
  const port = match ? Number(match[1]) : NaN;
  if (
    !match ||
    !Number.isInteger(port) ||
    port < EMULATOR_MIN_PORT ||
    port > EMULATOR_MAX_PORT ||
    port % 2 !== 0
  ) {
    throw new Error(
      `Invalid emulator udid "${udid}". Expected "emulator-<port>" with an even port between ` +
        `${EMULATOR_MIN_PORT} and ${EMULATOR_MAX_PORT}, e.g. "emulator-5554".`,
    );
  }
  return port;
}

/**
 * Port of the shared Appium server started by globalSetup, read from the environment.
 */
export function getAppiumPort(): number {
  const raw = process.env[APPIUM_PORT_ENV];
  const port = raw ? Number(raw) : NaN;
  if (!raw || !Number.isInteger(port) || port <= 0) {
    throw new Error(
      `Appium server port not found in ${APPIUM_PORT_ENV}. Is the Appwright globalSetup running? ` +
        'Make sure the config is created with `defineConfig` from appwright.',
    );
  }
  return port;
}

function assertValidSlot(slot: number) {
  if (!Number.isInteger(slot) || slot < 0) {
    throw new Error(`Worker slot must be a non-negative integer, got ${slot}.`);
  }
}
