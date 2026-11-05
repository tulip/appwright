import { describe, expect, test } from 'vitest';

import {
  classifyAndroidDevice,
  classifyAndroidEmulator,
  classifyIOSDevice,
  classifyIOSSimulator,
  deviceKind,
  parseAdbDevices,
  parseDevicectlDevices,
  parseSimctlDevices,
  parseXctraceDevices,
} from '../providers/availability';
import { Platform } from '../types';

const ADB_OUTPUT = `* daemon not running; starting now at tcp:5037
* daemon started successfully
List of devices attached
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
emulator-5556          offline transport_id:2
R5CT1234ABC            unauthorized usb:1-1 transport_id:3
0A121FDD4003HZ         device usb:1-2 product:husky model:Pixel_8_Pro device:husky transport_id:4

`;

describe('deviceKind', () => {
  test('maps provider and platform to the four local kinds', () => {
    expect(deviceKind('emulator', Platform.ANDROID)).toBe('android-emulator');
    expect(deviceKind('local-device', Platform.ANDROID)).toBe('android-device');
    expect(deviceKind('emulator', Platform.IOS)).toBe('ios-simulator');
    expect(deviceKind('local-device', Platform.IOS)).toBe('ios-device');
  });
});

describe('parseAdbDevices', () => {
  test('reads serial, state and model, skipping daemon chatter', () => {
    expect(parseAdbDevices(ADB_OUTPUT)).toEqual([
      { serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 arm64' },
      { serial: 'emulator-5556', state: 'offline' },
      { serial: 'R5CT1234ABC', state: 'unauthorized' },
      { serial: '0A121FDD4003HZ', state: 'device', model: 'Pixel 8 Pro' },
    ]);
  });
});

describe('Android emulator availability', () => {
  const adb = parseAdbDevices(ADB_OUTPUT);

  test('online when adb lists it as `device`, with the running AVD', () => {
    expect(classifyAndroidEmulator({ udid: 'emulator-5554' }, adb, undefined, 'Pixel_A')).toEqual({
      usable: true,
      state: 'online',
      avd: 'Pixel_A',
      name: 'Pixel_A',
    });
  });

  test('a listed emulator in another state is unavailable with that state', () => {
    expect(classifyAndroidEmulator({ udid: 'emulator-5556' }, adb, ['Pixel_A'])).toMatchObject({
      usable: false,
      reason: 'adb reports it as "offline"',
    });
  });

  test('not running but bootable from its installed AVD', () => {
    expect(
      classifyAndroidEmulator({ udid: 'emulator-5558', avd: 'Pixel_B' }, adb, [
        'Pixel_A',
        'Pixel_B',
      ]),
    ).toMatchObject({ usable: true, state: 'bootable', avd: 'Pixel_B' });
  });

  test('not running and its AVD is not installed', () => {
    expect(
      classifyAndroidEmulator({ udid: 'emulator-5558', avd: 'Missing' }, adb, ['Pixel_A']),
    ).toMatchObject({
      usable: false,
      reason: expect.stringContaining('"Missing" is not installed'),
    });
  });

  test('not running without an `avd` falls back to the first installed AVD', () => {
    expect(
      classifyAndroidEmulator({ udid: 'emulator-5558' }, adb, ['Pixel_A', 'Pixel_B']),
    ).toMatchObject({ usable: true, state: 'bootable', avd: 'Pixel_A' });
  });

  test('not running with no AVDs installed', () => {
    expect(classifyAndroidEmulator({ udid: 'emulator-5558' }, adb, [])).toMatchObject({
      usable: false,
      reason: 'not running and no AVDs are installed',
    });
  });
});

describe('Android physical device availability', () => {
  const adb = parseAdbDevices(ADB_OUTPUT);

  test('connected and authorized', () => {
    expect(classifyAndroidDevice({ udid: '0A121FDD4003HZ' }, adb)).toEqual({
      usable: true,
      state: 'online',
      name: 'Pixel 8 Pro',
    });
  });

  test('unauthorized, offline and missing are reported distinctly', () => {
    expect(classifyAndroidDevice({ udid: 'R5CT1234ABC' }, adb).reason).toMatch(/^unauthorized/);
    expect(classifyAndroidDevice({ udid: 'emulator-5556' }, adb).reason).toMatch(/^offline/);
    expect(classifyAndroidDevice({ udid: 'NOPE' }, adb).reason).toMatch(/^not connected/);
  });
});

const SIMCTL_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
      { udid: 'BOOTED', name: 'iPhone 18 Pro', state: 'Booted', isAvailable: true },
      { udid: 'OFF', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
      { udid: 'BUSY', name: 'iPhone 17 Pro', state: 'Shutting Down', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-16-0': [
      { udid: 'OLD', name: 'iPhone 14', state: 'Shutdown', isAvailable: false },
    ],
  },
});

describe('iOS simulator availability', () => {
  const simulators = parseSimctlDevices(SIMCTL_JSON);

  test('booted is online, shut down is bootable', () => {
    expect(classifyIOSSimulator({ udid: 'BOOTED' }, simulators)).toEqual({
      usable: true,
      state: 'online',
      name: 'iPhone 18 Pro',
    });
    expect(classifyIOSSimulator({ udid: 'OFF' }, simulators)).toEqual({
      usable: true,
      state: 'bootable',
      name: 'iPhone 17',
    });
  });

  test('missing runtime, transitional state and unknown udid are unavailable', () => {
    expect(classifyIOSSimulator({ udid: 'OLD' }, simulators).reason).toMatch(/runtime is missing/);
    expect(classifyIOSSimulator({ udid: 'BUSY' }, simulators).reason).toMatch(/Shutting Down/);
    expect(classifyIOSSimulator({ udid: 'NOPE' }, simulators).reason).toMatch(/no simulator/);
  });
});

const DEVICECTL_JSON = JSON.stringify({
  result: {
    devices: [
      {
        hardwareProperties: { udid: '00008103-000C68A83413401E', reality: 'physical' },
        deviceProperties: { name: 'Tulip’s iPad' },
        connectionProperties: { pairingState: 'paired', tunnelState: 'unavailable' },
      },
      {
        hardwareProperties: { udid: '00008110-001A2B3C4D5E6F70', reality: 'physical' },
        deviceProperties: { name: 'QA iPhone' },
        connectionProperties: {
          pairingState: 'paired',
          tunnelState: 'disconnected',
          transportType: 'wired',
        },
      },
      {
        hardwareProperties: { udid: '00008120-AAAA', reality: 'physical' },
        deviceProperties: { name: 'Unpaired' },
        connectionProperties: { pairingState: 'unpaired', tunnelState: 'disconnected' },
      },
      {
        hardwareProperties: { udid: 'A1B3C2AB-F627-4679-BB08-18DA2D17AD24', reality: 'simulated' },
        deviceProperties: { name: 'iPhone 18 Pro' },
        connectionProperties: { pairingState: 'paired', tunnelState: 'connected' },
      },
    ],
  },
});

const XCTRACE_OUTPUT = `== Devices ==
MacBook Pro (ADF539E1-AC9B-5C30-A717-E4ECC9F29A39)
QA iPhone (26.1) (00008110-001A2B3C4D5E6F70)

== Devices Offline ==
Tulip’s iPad (27.0) (00008103-000C68A83413401E)

== Simulators ==
iPhone 17 Simulator (26.5) (711718D0-4D56-4967-AEFF-44F0BF771F98)
`;

describe('iOS physical device availability', () => {
  test('devicectl: physical devices only; reachable unless the tunnel is unavailable', () => {
    expect(parseDevicectlDevices(DEVICECTL_JSON)).toEqual([
      {
        udid: '00008103-000C68A83413401E',
        name: 'Tulip’s iPad',
        connected: false,
        state: 'unavailable',
      },
      {
        udid: '00008110-001A2B3C4D5E6F70',
        name: 'QA iPhone',
        connected: true,
        state: 'disconnected',
      },
      { udid: '00008120-AAAA', name: 'Unpaired', connected: false, state: 'pairing unpaired' },
    ]);
  });

  test('xctrace: online and offline sections, skipping the Mac and simulators', () => {
    expect(parseXctraceDevices(XCTRACE_OUTPUT)).toEqual([
      { name: 'QA iPhone', udid: '00008110-001A2B3C4D5E6F70', connected: true, state: 'connected' },
      {
        name: 'Tulip’s iPad',
        udid: '00008103-000C68A83413401E',
        connected: false,
        state: 'offline',
      },
    ]);
  });

  test('classification', () => {
    const devices = parseDevicectlDevices(DEVICECTL_JSON);
    expect(classifyIOSDevice({ udid: '00008110-001a2b3c4d5e6f70' }, devices)).toEqual({
      usable: true,
      state: 'online',
      name: 'QA iPhone',
    });
    expect(classifyIOSDevice({ udid: '00008103-000C68A83413401E' }, devices).reason).toBe(
      'not connected (unavailable)',
    );
    expect(classifyIOSDevice({ udid: 'NOPE' }, devices).reason).toMatch(
      /not connected or not paired/,
    );
  });
});
