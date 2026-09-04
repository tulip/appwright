import { DeviceEntry, Platform } from '../../types';

/**
 * Lists installed Android AVDs (`emulator -list-avds`). Throws with installation guidance when
 * none are installed.
 */
export async function listAvds(): Promise<string[]> {
  throw new Error('not implemented');
}

/**
 * Whether the device is online: Android checks `adb devices` for `<udid>\tdevice`; iOS checks
 * `xcrun simctl list devices booted -j` for the udid.
 */
export async function isDeviceOnline(platform: Platform, udid: string): Promise<boolean> {
  void platform;
  void udid;
  throw new Error('not implemented');
}

/**
 * Boots every entry that is not online yet and waits for it to finish booting.
 * Android boots `emulator -avd <avd> -port <port from udid>`; iOS runs
 * `xcrun simctl bootstatus <udid> -b`. Remembers which devices this process booted.
 * Throws when an Android entry is offline and has no `avd`.
 */
export async function ensureEmulatorsBooted(
  platform: Platform,
  entries: DeviceEntry[],
): Promise<void> {
  void platform;
  void entries;
  throw new Error('not implemented');
}

/**
 * Shuts down only the devices booted by `ensureEmulatorsBooted` in this process.
 * Never throws; failures are logged per device.
 */
export async function shutdownBootedEmulators(): Promise<void> {
  throw new Error('not implemented');
}
