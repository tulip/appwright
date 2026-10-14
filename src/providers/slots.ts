import os from 'os';
import path from 'path';

import { DeviceEntry, EmulatorConfig, LocalDeviceConfig, Platform } from '../types';
import { MAX_PORT_SLOTS } from './device-pool';

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
 * - iOS: `appium:wdaLocalPort` (WDA forward; on real devices the driver forwards it to port 8100 on
 *   that device), `appium:mjpegServerPort` (XCUITest binds it on every session, so it must be
 *   unique once set) and `appium:derivedDataPath` (per-device WDA build products, as recommended
 *   by the XCUITest parallel-tests guide).
 *
 * Ports come from the host-wide port slot leased with the device, not from the worker slot or the
 * device's position in its pool, so two concurrent runs (or two projects of one platform) never
 * get the same ports. They are not probed: the bases are the driver defaults and slots stop at
 * `MAX_PORT_SLOTS`, so the ranges are assumed free on the host. If something else holds one,
 * session creation fails inside the driver.
 */
export function getSlotCapabilities(
  platform: Platform,
  portSlot: number,
  udid?: string,
): Record<string, string | number> {
  if (!Number.isInteger(portSlot) || portSlot < 0 || portSlot >= MAX_PORT_SLOTS) {
    throw new Error(
      `Port slot must be an integer between 0 and ${MAX_PORT_SLOTS - 1}, got ${portSlot}.`,
    );
  }
  if (platform === Platform.ANDROID) {
    return {
      'appium:systemPort': ANDROID_SYSTEM_PORT_BASE + portSlot,
    };
  }
  const derivedDataDir = udid ? `device-${udid.replace(/[^A-Za-z0-9._-]+/g, '_')}` : `slot-${portSlot}`;
  return {
    'appium:wdaLocalPort': IOS_WDA_LOCAL_PORT_BASE + portSlot,
    'appium:mjpegServerPort': IOS_MJPEG_SERVER_PORT_BASE + portSlot,
    'appium:derivedDataPath': path.join(os.tmpdir(), 'appwright-wda', derivedDataDir),
  };
}

/**
 * Normalises the device configuration into the project's device pool, in config order.
 * `devices` wins; otherwise a single `udid` becomes a one-entry pool; otherwise the pool is
 * empty (legacy behaviour: the provider auto-picks a device for slot 0, with no lease).
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
 * Fails a run whose `workers` exceeds the devices it was given, before anything is booted.
 *
 * Only configs that opt into the `devices` list are checked. `workers` defaults to 2, and a
 * config written before `devices` existed names at most a single `udid`, so checking those would
 * reject them all on upgrade even though Playwright often spawns a single worker anyway
 * (`fullyParallel: false` with one spec file), which is what such runs relied on. They keep
 * working; a second worker instead fails in `getLeasedDeviceForSlot` when it asks for its device.
 */
export function assertWorkersFitDevices(
  device: SlotDeviceConfig,
  workers: number,
  projectName: string,
) {
  const configured = device.devices;
  if (!configured || configured.length === 0 || workers <= configured.length) {
    return;
  }
  throw new Error(
    `workers (${workers}) exceeds configured devices (${configured.length}) for project ` +
      `"${projectName}". Add entries to \`device.devices\` or set \`workers: ${configured.length}\`.`,
  );
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

/** Capability names defined by the W3C WebDriver spec; everything else needs a vendor prefix. */
const W3C_CAPABILITIES = new Set([
  'platformName',
  'browserName',
  'browserVersion',
  'acceptInsecureCerts',
  'pageLoadStrategy',
  'proxy',
  'setWindowRect',
  'timeouts',
  'strictFileInteractability',
  'unhandledPromptBehavior',
  'webSocketUrl',
]);

/**
 * Merges a project's `capabilities` over the ones appwright built, so a user value wins. Keys
 * without a vendor prefix (no `:`) that are not W3C capabilities get `appium:`.
 */
export function mergeCapabilities(
  base: Record<string, unknown>,
  overrides: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (overrides == null) {
    return base;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const name = key.includes(':') || W3C_CAPABILITIES.has(key) ? key : `appium:${key}`;
    merged[name] = value;
  }
  return merged;
}
