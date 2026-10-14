import { ChildProcess, execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  avdLeaseKey,
  defaultLeaseDir,
  describeHolder,
  deviceLeaseKey,
  isPidAlive,
  LEASE_DIR_ENV,
  LeaseOwner,
  LeaseStore,
  portSlotLeaseKey,
} from '../providers/leases';

const execFileAsync = promisify(execFile);

function owner(pid: number, runName = 'run-a'): LeaseOwner {
  return { pid, runName, project: 'android', cwd: '/work', startedAt: new Date().toISOString() };
}

/** Pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

let dir: string;
let store: LeaseStore;
const children: ChildProcess[] = [];

/** Pid of a live process other than this one, standing in for a concurrent run. */
function otherLivePid(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  children.push(child);
  return child.pid!;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appwright-leases-test-'));
  store = new LeaseStore(dir);
});

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('lease keys and paths', () => {
  test('keys are namespaced by kind', () => {
    expect(deviceLeaseKey('emulator-5554')).toBe('device:emulator-5554');
    expect(avdLeaseKey('Pixel_7')).toBe('avd:Pixel_7');
    expect(portSlotLeaseKey(3)).toBe('port:3');
  });

  test('distinct keys never share a file, even when their slugs match', () => {
    expect(store.fileFor('device:a/b')).not.toBe(store.fileFor('device:a_b'));
    expect(path.dirname(store.fileFor('device:../../etc'))).toBe(dir);
  });

  test('the lease dir defaults to the OS temp dir and can be overridden', () => {
    expect(defaultLeaseDir({})).toBe(path.join(os.tmpdir(), 'appwright-leases'));
    expect(defaultLeaseDir({ [LEASE_DIR_ENV]: '/custom' })).toBe('/custom');
  });
});

describe('LeaseStore', () => {
  test('acquire writes a record with the owner and release removes it', () => {
    expect(
      store.tryAcquire([deviceLeaseKey('x'), portSlotLeaseKey(0)], owner(process.pid)),
    ).toEqual({ ok: true });
    const record = store.read(deviceLeaseKey('x'));
    expect(record).toMatchObject({ key: 'device:x', pid: process.pid, runName: 'run-a' });
    expect(
      store
        .list()
        .map((lease) => lease.key)
        .sort(),
    ).toEqual(['device:x', 'port:0']);

    store.release([deviceLeaseKey('x'), portSlotLeaseKey(0)]);
    expect(store.read(deviceLeaseKey('x'))).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  test('a key held by another live process is refused, and nothing is taken', () => {
    const other = otherLivePid();
    store.tryAcquire([deviceLeaseKey('x')], owner(other, 'run-b'));

    const result = store.tryAcquire([deviceLeaseKey('y'), deviceLeaseKey('x')], owner(process.pid));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.held.map((lease) => lease.runName)).toEqual(['run-b']);
    expect(store.read(deviceLeaseKey('y'))).toBeUndefined();
  });

  test('re-acquiring keys the same pid already holds succeeds', () => {
    store.tryAcquire([deviceLeaseKey('x')], owner(process.pid));
    expect(store.tryAcquire([deviceLeaseKey('x')], owner(process.pid)).ok).toBe(true);
  });

  test('release leaves leases held by other processes alone', () => {
    const other = otherLivePid();
    store.tryAcquire([deviceLeaseKey('x')], owner(other, 'run-b'));
    store.release([deviceLeaseKey('x')]);
    expect(store.read(deviceLeaseKey('x'))?.runName).toBe('run-b');
  });

  test('a lease whose pid is dead is stale and reclaimed', async () => {
    const dead = await deadPid();
    expect(isPidAlive(dead)).toBe(false);
    store.withMutex(() => store.write(deviceLeaseKey('x'), owner(dead, 'crashed')));

    expect(store.read(deviceLeaseKey('x'))).toBeUndefined();
    expect(fs.existsSync(store.fileFor(deviceLeaseKey('x')))).toBe(false);
    expect(store.tryAcquire([deviceLeaseKey('x')], owner(process.pid)).ok).toBe(true);
  });

  test('an unreadable lease counts as held while fresh and is reclaimed once old', () => {
    const file = store.fileFor(deviceLeaseKey('x'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '{"pid":');
    expect(store.tryAcquire([deviceLeaseKey('x')], owner(process.pid)).ok).toBe(false);

    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    expect(store.tryAcquire([deviceLeaseKey('x')], owner(process.pid)).ok).toBe(true);
  });

  test('a mutex left behind by a dead process is reclaimed', async () => {
    const mutex = path.join(dir, '.mutex');
    fs.mkdirSync(mutex, { recursive: true });
    fs.writeFileSync(path.join(mutex, 'owner'), String(await deadPid()));
    expect(store.tryAcquire([deviceLeaseKey('x')], owner(process.pid)).ok).toBe(true);
    expect(fs.existsSync(mutex)).toBe(false);
  });

  test('describeHolder names the run, project and pid', () => {
    const text = describeHolder({ key: 'device:x', ...owner(1234, 'nightly') });
    expect(text).toContain('run "nightly"');
    expect(text).toContain('project "android"');
    expect(text).toContain('pid 1234');
  });
});

// Node loads the TypeScript source directly only where type stripping is available (Node 22.18+).
const canRunTs = !!(process.features as { typescript?: unknown }).typescript;

describe.runIf(canRunTs)('LeaseStore across processes', () => {
  test('of many processes racing for one device, exactly one gets it', async () => {
    const leasesModule = path.resolve(__dirname, '../providers/leases.ts');
    // All racers spin until the same instant, then acquire. Every racer stays alive afterwards so
    // the winner's lease is live while the others check.
    const startAt = Date.now() + 2000;
    const script = `
      const { LeaseStore } = require(${JSON.stringify(leasesModule)});
      const store = new LeaseStore(${JSON.stringify(dir)});
      while (Date.now() < ${startAt}) {}
      const result = store.tryAcquire(['device:shared'], {
        pid: process.pid, runName: 'racer', cwd: '.', startedAt: '',
      });
      process.stdout.write(result.ok ? 'won' : 'lost');
      setTimeout(() => {}, 3000);
    `;
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        execFileAsync(process.execPath, ['-e', script]).then(({ stdout }) => stdout),
      ),
    );
    expect(results.filter((result) => result === 'won')).toHaveLength(1);
    expect(results.filter((result) => result === 'lost')).toHaveLength(11);
  }, 30_000);
});
