import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { DeviceEntry, Platform } from '../types';

const execFileAsync = promisify(execFile);

const QUERY_TIMEOUT_MS = 30 * 1000;

/** The four kinds of local device appwright drives. */
export type DeviceKind = 'android-emulator' | 'android-device' | 'ios-simulator' | 'ios-device';

export function deviceKind(provider: 'emulator' | 'local-device', platform: Platform): DeviceKind {
  if (platform === Platform.ANDROID) {
    return provider === 'emulator' ? 'android-emulator' : 'android-device';
  }
  return provider === 'emulator' ? 'ios-simulator' : 'ios-device';
}

/**
 * Whether a pool entry can be used right now, ignoring leases.
 *
 * - `online`: running and reachable.
 * - `bootable`: not running, but appwright can boot it (Android AVD or iOS simulator).
 * - anything else is unusable, and `reason` says why.
 */
export type Availability = {
  usable: boolean;
  state: 'online' | 'bootable' | 'unavailable';
  reason?: string;
  /** Name the platform reports for the device (simulator name, device name, adb model). */
  name?: string;
  /** Android emulator: the AVD this entry runs or will be booted from. */
  avd?: string;
};

// ---------------------------------------------------------------------------
// Parsers (pure, unit tested)
// ---------------------------------------------------------------------------

export type AdbDevice = { serial: string; state: string; model?: string };

/** Parses `adb devices -l`. */
export function parseAdbDevices(stdout: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) {
      continue;
    }
    const [serial, state, ...rest] = line.split(/\s+/);
    if (!serial || !state) {
      continue;
    }
    const model = rest.find((part) => part.startsWith('model:'))?.slice('model:'.length);
    devices.push(model ? { serial, state, model: model.replace(/_/g, ' ') } : { serial, state });
  }
  return devices;
}

export type SimctlDevice = { udid: string; name: string; state: string; isAvailable: boolean };

/** Parses `xcrun simctl list devices -j`. */
export function parseSimctlDevices(json: string): SimctlDevice[] {
  const parsed = JSON.parse(json) as {
    devices?: Record<
      string,
      Array<{ udid?: string; name?: string; state?: string; isAvailable?: boolean }>
    >;
  };
  return Object.values(parsed.devices ?? {}).flatMap((runtimeDevices) =>
    runtimeDevices
      .filter((device) => !!device.udid)
      .map((device) => ({
        udid: device.udid!,
        name: device.name ?? '',
        state: device.state ?? 'Unknown',
        isAvailable: device.isAvailable !== false,
      })),
  );
}

export type PhysicalIOSDevice = { udid: string; name: string; connected: boolean; state: string };

/**
 * Parses the JSON written by `xcrun devicectl list devices --json-output <file>`, keeping physical
 * devices only. A device whose `tunnelState` is `unavailable` is paired but not reachable.
 */
export function parseDevicectlDevices(json: string): PhysicalIOSDevice[] {
  const parsed = JSON.parse(json) as {
    result?: {
      devices?: Array<{
        hardwareProperties?: { udid?: string; reality?: string };
        deviceProperties?: { name?: string };
        connectionProperties?: { tunnelState?: string; pairingState?: string };
      }>;
    };
  };
  return (parsed.result?.devices ?? [])
    .filter(
      (device) =>
        device.hardwareProperties?.reality === 'physical' && device.hardwareProperties.udid,
    )
    .map((device) => {
      const tunnelState = device.connectionProperties?.tunnelState ?? 'unavailable';
      const pairingState = device.connectionProperties?.pairingState ?? 'unknown';
      const connected = tunnelState !== 'unavailable' && pairingState === 'paired';
      return {
        udid: device.hardwareProperties!.udid!,
        name: device.deviceProperties?.name ?? '',
        connected,
        state: pairingState === 'paired' ? tunnelState : `pairing ${pairingState}`,
      };
    });
}

/**
 * Parses `xcrun xctrace list devices`. Devices under `== Devices ==` are connected, those under
 * `== Devices Offline ==` are not; simulators and the Mac itself are skipped (the Mac has no
 * OS version in parentheses).
 */
export function parseXctraceDevices(stdout: string): PhysicalIOSDevice[] {
  const devices: PhysicalIOSDevice[] = [];
  let section: 'online' | 'offline' | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('==')) {
      section = line.includes('Devices Offline')
        ? 'offline'
        : line.includes('== Devices ==')
        ? 'online'
        : undefined;
      continue;
    }
    if (!section) {
      continue;
    }
    // e.g. `User’s iPhone (18.0) (00003110-002A304e3A53C41E)`
    const match = line.match(/^(.+?)\s+\([\d.]+\)(?:\s+-\s+\w+)?\s+\(([0-9A-Fa-f-]+)\)\s*$/);
    if (match) {
      devices.push({
        name: match[1]!.trim(),
        udid: match[2]!,
        connected: section === 'online',
        state: section === 'online' ? 'connected' : 'offline',
      });
    }
  }
  return devices;
}

// ---------------------------------------------------------------------------
// Classification (pure, unit tested)
// ---------------------------------------------------------------------------

export function classifyAndroidEmulator(
  entry: DeviceEntry,
  adbDevices: AdbDevice[],
  installedAvds: string[] | undefined,
  runningAvd?: string,
): Availability {
  const listed = adbDevices.find((device) => device.serial === entry.udid);
  if (listed?.state === 'device') {
    return { usable: true, state: 'online', avd: runningAvd ?? entry.avd, name: runningAvd };
  }
  if (listed) {
    return {
      usable: false,
      state: 'unavailable',
      reason: `adb reports it as "${listed.state}"`,
      avd: entry.avd,
    };
  }
  if (!installedAvds || installedAvds.length === 0) {
    return { usable: false, state: 'unavailable', reason: 'not running and no AVDs are installed' };
  }
  if (entry.avd) {
    if (!installedAvds.includes(entry.avd)) {
      return {
        usable: false,
        state: 'unavailable',
        reason: `not running, and AVD "${
          entry.avd
        }" is not installed (installed: ${installedAvds.join(', ')})`,
      };
    }
    return { usable: true, state: 'bootable', avd: entry.avd, name: entry.avd };
  }
  // Same fallback as the boot code: an entry without `avd` boots the first installed AVD.
  return { usable: true, state: 'bootable', avd: installedAvds[0], name: installedAvds[0] };
}

export function classifyAndroidDevice(entry: DeviceEntry, adbDevices: AdbDevice[]): Availability {
  const listed = adbDevices.find((device) => device.serial === entry.udid);
  if (!listed) {
    return { usable: false, state: 'unavailable', reason: 'not connected (not in `adb devices`)' };
  }
  switch (listed.state) {
    case 'device':
      return { usable: true, state: 'online', name: listed.model };
    case 'unauthorized':
      return {
        usable: false,
        state: 'unavailable',
        reason: 'unauthorized: accept the USB debugging prompt on the device',
        name: listed.model,
      };
    case 'offline':
      return {
        usable: false,
        state: 'unavailable',
        reason: 'offline: reconnect the cable or restart adb',
        name: listed.model,
      };
    default:
      return {
        usable: false,
        state: 'unavailable',
        reason: `adb reports it as "${listed.state}"`,
        name: listed.model,
      };
  }
}

export function classifyIOSSimulator(entry: DeviceEntry, simulators: SimctlDevice[]): Availability {
  const found = simulators.find((device) => device.udid === entry.udid);
  if (!found) {
    return {
      usable: false,
      state: 'unavailable',
      reason: 'no simulator with this udid (see `xcrun simctl list devices`)',
    };
  }
  if (!found.isAvailable) {
    return {
      usable: false,
      state: 'unavailable',
      reason: 'simulator is unavailable (its runtime is missing)',
      name: found.name,
    };
  }
  if (found.state === 'Booted') {
    return { usable: true, state: 'online', name: found.name };
  }
  if (found.state === 'Shutdown') {
    return { usable: true, state: 'bootable', name: found.name };
  }
  return {
    usable: false,
    state: 'unavailable',
    reason: `simulator is "${found.state}"`,
    name: found.name,
  };
}

export function classifyIOSDevice(entry: DeviceEntry, devices: PhysicalIOSDevice[]): Availability {
  const found = devices.find((device) => device.udid.toLowerCase() === entry.udid.toLowerCase());
  if (!found) {
    return {
      usable: false,
      state: 'unavailable',
      reason: 'not connected or not paired with this Mac',
    };
  }
  if (!found.connected) {
    return {
      usable: false,
      state: 'unavailable',
      reason: `not connected (${found.state})`,
      name: found.name,
    };
  }
  return { usable: true, state: 'online', name: found.name };
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/**
 * Checks every pool entry with one query per tool. Throws when the tool itself is missing or
 * fails, since nothing in the pool can be judged then.
 */
export async function probeAvailability(
  kind: DeviceKind,
  entries: DeviceEntry[],
): Promise<Map<string, Availability>> {
  const result = new Map<string, Availability>();
  if (entries.length === 0) {
    return result;
  }
  switch (kind) {
    case 'android-emulator': {
      const adbDevices = await listAdbDevices();
      const needsAvds = entries.some(
        (entry) => !adbDevices.some((device) => device.serial === entry.udid),
      );
      const installedAvds = needsAvds ? await listInstalledAvds() : undefined;
      for (const entry of entries) {
        const online = adbDevices.some(
          (device) => device.serial === entry.udid && device.state === 'device',
        );
        const runningAvd = online ? await runningAvdName(entry.udid) : undefined;
        result.set(
          entry.udid,
          classifyAndroidEmulator(entry, adbDevices, installedAvds, runningAvd),
        );
      }
      break;
    }
    case 'android-device': {
      const adbDevices = await listAdbDevices();
      for (const entry of entries) {
        result.set(entry.udid, classifyAndroidDevice(entry, adbDevices));
      }
      break;
    }
    case 'ios-simulator': {
      const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', '-j'], {
        timeout: QUERY_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      });
      const simulators = parseSimctlDevices(stdout);
      for (const entry of entries) {
        result.set(entry.udid, classifyIOSSimulator(entry, simulators));
      }
      break;
    }
    case 'ios-device': {
      const devices = await listPhysicalIOSDevices();
      for (const entry of entries) {
        result.set(entry.udid, classifyIOSDevice(entry, devices));
      }
      break;
    }
  }
  return result;
}

async function listAdbDevices(): Promise<AdbDevice[]> {
  try {
    const { stdout } = await execFileAsync('adb', ['devices', '-l'], { timeout: QUERY_TIMEOUT_MS });
    return parseAdbDevices(stdout);
  } catch (error: any) {
    throw new Error(
      `Could not list Android devices with \`adb devices\`: ${error?.message ?? error}. ` +
        'Make sure the Android SDK platform-tools are on PATH.',
    );
  }
}

async function listInstalledAvds(): Promise<string[]> {
  const androidHome = process.env.ANDROID_HOME;
  if (!androidHome) {
    return [];
  }
  try {
    const { stdout } = await execFileAsync(
      path.join(androidHome, 'emulator', 'emulator'),
      ['-list-avds'],
      { timeout: QUERY_TIMEOUT_MS },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('INFO') && !line.includes('/tmp/'));
  } catch {
    return [];
  }
}

/** Name of the AVD an online emulator runs (`adb emu avd name`), or undefined if it can't be read. */
async function runningAvdName(udid: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('adb', ['-s', udid, 'emu', 'avd', 'name'], {
      timeout: QUERY_TIMEOUT_MS,
    });
    const name = stdout.split('\n')[0]?.trim();
    return name && name !== 'OK' ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Physical iOS devices from devicectl (Xcode 15+), falling back to xctrace. */
export async function listPhysicalIOSDevices(): Promise<PhysicalIOSDevice[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appwright-devicectl-'));
  const jsonFile = path.join(tmpDir, 'devices.json');
  try {
    await execFileAsync(
      'xcrun',
      ['devicectl', 'list', 'devices', '--quiet', '--json-output', jsonFile],
      { timeout: QUERY_TIMEOUT_MS },
    );
    return parseDevicectlDevices(fs.readFileSync(jsonFile, 'utf-8'));
  } catch {
    const { stdout } = await execFileAsync('xcrun', ['xctrace', 'list', 'devices'], {
      timeout: QUERY_TIMEOUT_MS,
    });
    return parseXctraceDevices(stdout);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
