import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { Availability, DeviceKind } from '../providers/availability';
import {
  DeviceSelectionError,
  getLeasedDeviceForSlot,
  LEASED_DEVICES_ENV,
  leaseRunDevices,
  matchPinnedDevice,
  PoolProject,
} from '../providers/device-pool';
import { avdLeaseKey, deviceLeaseKey, LeaseStore, portSlotLeaseKey } from '../providers/leases';
import { DeviceEntry } from '../types';

const online = (name?: string, avd?: string): Availability => ({
  usable: true,
  state: 'online',
  ...(name && { name }),
  ...(avd && { avd }),
});
const bootable = (name?: string, avd?: string): Availability => ({
  usable: true,
  state: 'bootable',
  ...(name && { name }),
  ...(avd && { avd }),
});
const unavailable = (reason: string): Availability => ({
  usable: false,
  state: 'unavailable',
  reason,
});

let dir: string;
let store: LeaseStore;
const children: ChildProcess[] = [];

/** Leases `keys` for a live process other than this one, standing in for a concurrent run. */
function heldByOtherRun(keys: string[], runName = 'other-run') {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  children.push(child);
  const result = store.tryAcquire(keys, {
    pid: child.pid!,
    runName,
    project: 'android',
    cwd: '/elsewhere',
    startedAt: new Date().toISOString(),
  });
  expect(result.ok).toBe(true);
  return child;
}

function project(overrides: Partial<PoolProject> & { pool: DeviceEntry[] }): PoolProject {
  return { name: 'android', kind: 'android-emulator', count: 1, ...overrides };
}

function probeFrom(statuses: Record<string, Availability>) {
  return async (_kind: DeviceKind, entries: DeviceEntry[]) =>
    new Map(entries.map((entry) => [entry.udid, statuses[entry.udid] ?? unavailable('unknown')]));
}

const twoEmulators: DeviceEntry[] = [
  { udid: 'emulator-5554', avd: 'Pixel_A' },
  { udid: 'emulator-5556', avd: 'Pixel_B' },
];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appwright-pool-test-'));
  store = new LeaseStore(dir);
});

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('leaseRunDevices without --device', () => {
  test('takes the first free device, its AVD and a port slot', async () => {
    const leases = await leaseRunDevices([project({ pool: twoEmulators })], {
      runName: 'run-a',
      workers: 1,
      store,
      probe: probeFrom({
        'emulator-5554': bootable('Pixel_A', 'Pixel_A'),
        'emulator-5556': bootable('Pixel_B', 'Pixel_B'),
      }),
    });
    expect(leases.byProject.android).toEqual([
      { udid: 'emulator-5554', avd: 'Pixel_A', name: 'Pixel_A', portSlot: 0, online: false },
    ]);
    expect(leases.keys.sort()).toEqual(
      [deviceLeaseKey('emulator-5554'), avdLeaseKey('Pixel_A'), portSlotLeaseKey(0)].sort(),
    );
    expect(store.read(deviceLeaseKey('emulator-5554'))).toMatchObject({
      pid: process.pid,
      runName: 'run-a',
      project: 'android',
    });

    leases.release();
    expect(store.list()).toEqual([]);
  });

  test('skips a device another run holds and does not reuse its port slot', async () => {
    heldByOtherRun([deviceLeaseKey('emulator-5554'), avdLeaseKey('Pixel_A'), portSlotLeaseKey(0)]);
    const leases = await leaseRunDevices([project({ pool: twoEmulators })], {
      runName: 'run-b',
      workers: 1,
      store,
      probe: probeFrom({
        'emulator-5554': online('Pixel_A', 'Pixel_A'),
        'emulator-5556': bootable('Pixel_B', 'Pixel_B'),
      }),
    });
    expect(leases.byProject.android).toMatchObject([{ udid: 'emulator-5556', portSlot: 1 }]);
  });

  test('a busy AVD makes its entry busy even under another udid', async () => {
    heldByOtherRun([deviceLeaseKey('emulator-5580'), avdLeaseKey('Pixel_A')]);
    const leases = await leaseRunDevices([project({ pool: twoEmulators })], {
      runName: 'run-b',
      workers: 1,
      store,
      probe: probeFrom({
        'emulator-5554': bootable('Pixel_A', 'Pixel_A'),
        'emulator-5556': bootable('Pixel_B', 'Pixel_B'),
      }),
    });
    expect(leases.byProject.android![0]!.udid).toBe('emulator-5556');
  });

  test('two runs in a row get different devices and port slots', async () => {
    const probe = probeFrom({
      'emulator-5554': online('Pixel_A', 'Pixel_A'),
      'emulator-5556': online('Pixel_B', 'Pixel_B'),
    });
    const first = await leaseRunDevices([project({ pool: twoEmulators })], {
      runName: 'a',
      workers: 1,
      store,
      probe,
    });
    // A second run in the same process would count as the same owner, so hand the first run's
    // leases to another live pid.
    const keys = first.keys;
    first.release();
    heldByOtherRun(keys, 'a');
    const second = await leaseRunDevices([project({ pool: twoEmulators })], {
      runName: 'b',
      workers: 1,
      store,
      probe,
    });
    expect(first.byProject.android![0]).toMatchObject({ udid: 'emulator-5554', portSlot: 0 });
    expect(second.byProject.android![0]).toMatchObject({ udid: 'emulator-5556', portSlot: 1 });
  });

  test('leases one device per worker', async () => {
    const leases = await leaseRunDevices([project({ pool: twoEmulators, count: 2 })], {
      runName: 'a',
      workers: 2,
      store,
      probe: probeFrom({ 'emulator-5554': online(), 'emulator-5556': online() }),
    });
    expect(leases.byProject.android!.map((device) => [device.udid, device.portSlot])).toEqual([
      ['emulator-5554', 0],
      ['emulator-5556', 1],
    ]);
  });

  test('a busy pool fails fast and says who holds each device', async () => {
    heldByOtherRun([deviceLeaseKey('emulator-5554')], 'nightly');
    const error = await leaseRunDevices([project({ pool: twoEmulators })], {
      runName: 'b',
      workers: 1,
      store,
      probe: probeFrom({
        'emulator-5554': online(),
        'emulator-5556': unavailable('not running, and AVD "Pixel_B" is not installed'),
      }),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(DeviceSelectionError);
    expect(error.retriable).toBe(true);
    expect(error.message).toContain('needs 1 device(s) but only 0 of 2');
    expect(error.message).toContain('emulator-5554');
    expect(error.message).toContain('run "nightly"');
    expect(error.message).toContain('AVD "Pixel_B" is not installed');
    expect(error.message).toContain('--wait-for-device');
    expect(store.list().map((lease) => lease.runName)).toEqual(['nightly']);
  });

  test('a pool that is only unavailable is not worth waiting for', async () => {
    const error = await leaseRunDevices([project({ pool: twoEmulators })], {
      runName: 'b',
      workers: 1,
      waitSeconds: 60,
      store,
      probe: probeFrom({}),
      sleep: async () => {
        throw new Error('should not wait');
      },
    }).catch((e) => e);
    expect(error.retriable).toBe(false);
    expect(error.message).not.toContain('--wait-for-device');
  });

  test('--wait-for-device retries until the holder releases the device', async () => {
    const holder = heldByOtherRun([deviceLeaseKey('emulator-5554')]);
    let sleeps = 0;
    const leases = await leaseRunDevices([project({ pool: [twoEmulators[0]!] })], {
      runName: 'b',
      workers: 1,
      waitSeconds: 60,
      store,
      probe: probeFrom({ 'emulator-5554': online() }),
      sleep: async () => {
        sleeps++;
        holder.kill('SIGKILL');
        await new Promise((resolve) => holder.once('exit', resolve));
      },
    });
    expect(sleeps).toBe(1);
    expect(leases.byProject.android![0]!.udid).toBe('emulator-5554');
  });

  test('all or nothing: when one project fails, the other leases nothing', async () => {
    const error = await leaseRunDevices(
      [
        project({ pool: twoEmulators }),
        project({ name: 'ios', kind: 'ios-simulator', pool: [{ udid: 'SIM-1' }] }),
      ],
      {
        runName: 'a',
        workers: 1,
        store,
        probe: probeFrom({ 'emulator-5554': online(), 'SIM-1': unavailable('no simulator') }),
      },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(DeviceSelectionError);
    expect(store.list()).toEqual([]);
  });

  test('two projects of one run never share a device', async () => {
    const pool = [{ udid: 'shared' }, { udid: 'second' }];
    const leases = await leaseRunDevices(
      [
        project({ name: 'one', kind: 'android-device', pool }),
        project({ name: 'two', kind: 'android-device', pool }),
      ],
      { runName: 'a', workers: 1, store, probe: probeFrom({ shared: online(), second: online() }) },
    );
    expect(leases.byProject.one![0]!.udid).toBe('shared');
    expect(leases.byProject.two![0]!.udid).toBe('second');
    expect(leases.byProject.one![0]!.portSlot).not.toBe(leases.byProject.two![0]!.portSlot);
  });

  test('a legacy config without a pool still leases a port slot', async () => {
    const leases = await leaseRunDevices([project({ kind: 'android-device', pool: [] })], {
      runName: 'a',
      workers: 1,
      store,
      probe: probeFrom({}),
    });
    expect(leases.byProject.android).toEqual([{ portSlot: 0 }]);
  });
});

describe('leaseRunDevices with --device', () => {
  const pool: DeviceEntry[] = [
    { udid: 'emulator-5554', avd: 'Pixel_A' },
    { udid: 'emulator-5556', avd: 'Pixel_B', name: 'big phone' },
  ];
  const probe = probeFrom({
    'emulator-5554': online('Pixel_A', 'Pixel_A'),
    'emulator-5556': bootable('Pixel_B', 'Pixel_B'),
  });

  test('pins the run to the device named by udid', async () => {
    const leases = await leaseRunDevices([project({ pool })], {
      runName: 'a',
      workers: 1,
      pinned: 'emulator-5556',
      store,
      probe,
    });
    expect(leases.byProject.android!.map((device) => device.udid)).toEqual(['emulator-5556']);
  });

  test('matches the configured name, the AVD, case and _ vs space', async () => {
    for (const pinned of ['big phone', 'BIG_PHONE', 'pixel b']) {
      const leases = await leaseRunDevices([project({ pool })], {
        runName: 'a',
        workers: 1,
        pinned,
        store,
        probe,
      });
      expect(leases.byProject.android![0]!.udid).toBe('emulator-5556');
      leases.release();
    }
  });

  test('a device not in the pool fails and lists the pool', async () => {
    const error = await leaseRunDevices([project({ pool })], {
      runName: 'a',
      workers: 1,
      pinned: 'emulator-5560',
      store,
      probe,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(DeviceSelectionError);
    expect(error.message).toContain('not in the device pool of project "android"');
    expect(error.message).toContain('emulator-5556 (big phone)');
    expect(store.list()).toEqual([]);
  });

  test('an unavailable device fails with the platform reason, even with a wait', async () => {
    const error = await leaseRunDevices([project({ kind: 'android-device', pool })], {
      runName: 'a',
      workers: 1,
      pinned: 'emulator-5554',
      waitSeconds: 60,
      store,
      probe: probeFrom({
        'emulator-5554': unavailable('unauthorized: accept the USB debugging prompt'),
      }),
    }).catch((e) => e);
    expect(error.message).toContain('is not available: unauthorized');
    expect(error.retriable).toBe(false);
  });

  test('a held device is reported as busy even while it looks offline (still booting)', async () => {
    heldByOtherRun([deviceLeaseKey('emulator-5554')], 'nightly');
    const error = await leaseRunDevices([project({ pool })], {
      runName: 'a',
      workers: 1,
      pinned: 'emulator-5554',
      store,
      probe: probeFrom({ 'emulator-5554': unavailable('adb reports it as "offline"') }),
    }).catch((e) => e);
    expect(error.message).toContain('is in use by run "nightly"');
    expect(error.retriable).toBe(true);
  });

  test('a device another run holds fails without falling back to a free one', async () => {
    heldByOtherRun([deviceLeaseKey('emulator-5554')], 'nightly');
    const error = await leaseRunDevices([project({ pool })], {
      runName: 'a',
      workers: 1,
      pinned: 'emulator-5554',
      store,
      probe,
    }).catch((e) => e);
    expect(error.message).toContain('is in use by run "nightly"');
    expect(error.retriable).toBe(true);
    expect(store.read(deviceLeaseKey('emulator-5556'))).toBeUndefined();
  });

  test('more than one worker, more than one project, or no pool are rejected up front', async () => {
    const probeNever = async () => {
      throw new Error('should fail before probing');
    };
    await expect(
      leaseRunDevices([project({ pool })], {
        runName: 'a',
        workers: 2,
        pinned: 'emulator-5554',
        store,
        probe: probeNever,
      }),
    ).rejects.toThrow(/Pass --workers 1/);
    await expect(
      leaseRunDevices([project({ pool }), project({ name: 'ios', pool })], {
        runName: 'a',
        workers: 1,
        pinned: 'emulator-5554',
        store,
        probe: probeNever,
      }),
    ).rejects.toThrow(/2 local projects are selected/);
    await expect(
      leaseRunDevices([project({ pool: [] })], {
        runName: 'a',
        workers: 1,
        pinned: 'emulator-5554',
        store,
        probe: probeNever,
      }),
    ).rejects.toThrow(/needs a device pool/);
  });
});

describe('matchPinnedDevice', () => {
  test('a name matching two entries is ambiguous', () => {
    const pool = [{ udid: 'A' }, { udid: 'B' }];
    const availability = new Map([
      ['A', online('iPhone 17 Pro')],
      ['B', online('iPhone 17 Pro')],
    ]);
    expect(() => matchPinnedDevice('iPhone 17 Pro', pool, availability, 'ios')).toThrow(
      /matches 2 devices.*A, B.*Pass the udid/,
    );
  });

  test('matches the name the platform reports', () => {
    const pool = [{ udid: 'A' }, { udid: 'B' }];
    const availability = new Map([
      ['A', online('iPhone 17')],
      ['B', online('Tulip’s iPad')],
    ]);
    expect(matchPinnedDevice('tulip’s ipad', pool, availability, 'ios').udid).toBe('B');
  });

  test('an exact udid wins over a name', () => {
    const pool = [{ udid: 'A', name: 'B' }, { udid: 'B' }];
    expect(matchPinnedDevice('B', pool, new Map(), 'ios').udid).toBe('B');
  });
});

describe('getLeasedDeviceForSlot', () => {
  const env = {
    [LEASED_DEVICES_ENV]: JSON.stringify({
      android: [
        { udid: 'emulator-5556', portSlot: 3 },
        { udid: 'emulator-5554', portSlot: 4 },
      ],
      legacy: [{ portSlot: 0 }],
    }),
  };

  test('maps worker slot n to the n-th leased device, not the n-th pool entry', () => {
    expect(getLeasedDeviceForSlot('android', 0, env)).toEqual({
      udid: 'emulator-5556',
      portSlot: 3,
    });
    expect(getLeasedDeviceForSlot('android', 1, env)).toEqual({
      udid: 'emulator-5554',
      portSlot: 4,
    });
  });

  test('a slot beyond the leased devices throws', () => {
    expect(() => getLeasedDeviceForSlot('android', 2, env)).toThrow(/leased 2 device\(s\)/);
  });

  test('legacy: slot 0 has no udid, slot 1 points at `devices`', () => {
    expect(getLeasedDeviceForSlot('legacy', 0, env)).toEqual({ portSlot: 0 });
    expect(() => getLeasedDeviceForSlot('legacy', 1, env)).toThrow(/requires listing the devices/);
  });

  test('missing leases or an unknown project throw', () => {
    expect(() => getLeasedDeviceForSlot('android', 0, {})).toThrow(/globalSetup running/);
    expect(() => getLeasedDeviceForSlot('ios', 0, env)).toThrow(/No devices were leased/);
    expect(() => getLeasedDeviceForSlot('android', -1, env)).toThrow(/non-negative/);
  });
});
