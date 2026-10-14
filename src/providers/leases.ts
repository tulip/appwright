import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Overrides the directory that holds lease files. Defaults to `<os.tmpdir()>/appwright-leases`. */
export const LEASE_DIR_ENV = 'APPWRIGHT_LEASE_DIR';

/** How long to wait for another process to leave the critical section before giving up. */
const MUTEX_TIMEOUT_MS = 15_000;
const MUTEX_POLL_MS = 25;
/** A mutex directory with no readable owner is treated as abandoned after this long. */
const ORPHANED_MUTEX_MS = 5_000;
/** A lease file that cannot be parsed is treated as abandoned after this long. */
const CORRUPT_LEASE_MS = 10_000;

/** Who holds a lease. */
export type LeaseOwner = {
  pid: number;
  runName: string;
  project?: string;
  cwd: string;
  /** ISO timestamp. */
  startedAt: string;
};

export type LeaseRecord = LeaseOwner & { key: string };

export function defaultLeaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[LEASE_DIR_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv;
  }
  return path.join(os.tmpdir(), 'appwright-leases');
}

/** Lease key for a device udid. */
export function deviceLeaseKey(udid: string): string {
  return `device:${udid}`;
}

/** Lease key for an Android Virtual Device name. */
export function avdLeaseKey(avd: string): string {
  return `avd:${avd}`;
}

/** Lease key for a per-session port slot. */
export function portSlotLeaseKey(slot: number): string {
  return `port:${slot}`;
}

/** `true` while a process with this pid exists (EPERM means it exists but belongs to someone else). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-process leases on named resources (devices, AVDs, port slots), one JSON file per key.
 *
 * Every read-check-write runs inside a short host-wide mutex (an atomically created directory), so
 * two processes can never both see a key as free and take it. A lease whose pid is no longer alive
 * is stale and is reclaimed by the next process that wants the key.
 *
 * Everything is synchronous so that leases can be released from a `process.on('exit')` handler.
 */
export class LeaseStore {
  readonly dir: string;

  constructor(dir: string = defaultLeaseDir()) {
    this.dir = dir;
  }

  /** Runs `fn` while holding the host-wide lease mutex. */
  withMutex<T>(fn: () => T): T {
    fs.mkdirSync(this.dir, { recursive: true });
    const mutexDir = path.join(this.dir, '.mutex');
    const deadline = Date.now() + MUTEX_TIMEOUT_MS;
    for (;;) {
      try {
        fs.mkdirSync(mutexDir);
        break;
      } catch (error: any) {
        if (error?.code !== 'EEXIST') {
          throw error;
        }
      }
      if (this.isMutexAbandoned(mutexDir)) {
        fs.rmSync(mutexDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${MUTEX_TIMEOUT_MS / 1000} s waiting for the device lease lock ` +
            `${mutexDir}. If no other appwright run is starting, delete that directory.`,
        );
      }
      sleepSync(MUTEX_POLL_MS);
    }
    try {
      fs.writeFileSync(path.join(mutexDir, 'owner'), String(process.pid));
      return fn();
    } finally {
      fs.rmSync(mutexDir, { recursive: true, force: true });
    }
  }

  /**
   * The live lease on `key`, or `undefined` when the key is free. Removes a stale lease file as a
   * side effect. Call inside {@link withMutex} when the answer decides an acquisition.
   */
  read(key: string): LeaseRecord | undefined {
    const file = this.fileFor(key);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
    let record: LeaseRecord | undefined;
    try {
      record = JSON.parse(raw) as LeaseRecord;
    } catch {
      record = undefined;
    }
    if (!record || typeof record.pid !== 'number') {
      if (this.ageMs(file) > CORRUPT_LEASE_MS) {
        fs.rmSync(file, { force: true });
        return undefined;
      }
      return { key, pid: -1, runName: 'unknown', cwd: '', startedAt: '' };
    }
    if (!isPidAlive(record.pid)) {
      fs.rmSync(file, { force: true });
      return undefined;
    }
    return record;
  }

  /** Writes the lease. Only call inside {@link withMutex} after checking {@link read}. */
  write(key: string, owner: LeaseOwner) {
    const file = this.fileFor(key);
    const tmp = `${file}.${process.pid}.tmp`;
    const record: LeaseRecord = { key, ...owner };
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, file);
  }

  /**
   * Takes every key in `keys` for `owner`, or none of them. Keys already held by `owner.pid` count
   * as taken. Returns the live leases held by other processes when any key is busy.
   */
  tryAcquire(
    keys: readonly string[],
    owner: LeaseOwner,
  ): { ok: true } | { ok: false; held: LeaseRecord[] } {
    return this.withMutex(() => {
      const held = keys
        .map((key) => this.read(key))
        .filter((record): record is LeaseRecord => !!record && record.pid !== owner.pid);
      if (held.length > 0) {
        return { ok: false, held };
      }
      for (const key of new Set(keys)) {
        this.write(key, owner);
      }
      return { ok: true };
    });
  }

  /** Removes the leases on `keys` that `pid` holds. Leases held by anyone else are left alone. */
  release(keys: readonly string[], pid: number = process.pid) {
    this.withMutex(() => {
      for (const key of keys) {
        const record = this.read(key);
        if (record && record.pid === pid) {
          fs.rmSync(this.fileFor(key), { force: true });
        }
      }
    });
  }

  /** Every live lease. */
  list(): LeaseRecord[] {
    if (!fs.existsSync(this.dir)) {
      return [];
    }
    return this.withMutex(() =>
      fs
        .readdirSync(this.dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf-8')) as LeaseRecord;
          } catch {
            return undefined;
          }
        })
        .filter((record): record is LeaseRecord => !!record?.key)
        .map((record) => this.read(record.key))
        .filter((record): record is LeaseRecord => !!record),
    );
  }

  /** File for a key: a readable slug plus a hash, so distinct keys never share a file. */
  fileFor(key: string): string {
    const slug = key.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
    const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
    return path.join(this.dir, `${slug}-${hash}.json`);
  }

  private isMutexAbandoned(mutexDir: string): boolean {
    let owner: number;
    try {
      owner = Number(fs.readFileSync(path.join(mutexDir, 'owner'), 'utf-8'));
    } catch {
      return this.ageMs(mutexDir) > ORPHANED_MUTEX_MS;
    }
    return !isPidAlive(owner);
  }

  private ageMs(file: string): number {
    try {
      return Date.now() - fs.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  }
}

/** Human-readable description of who holds a lease, for error messages. */
export function describeHolder(record: LeaseRecord): string {
  if (record.pid < 0) {
    return 'a run that is still writing its lease';
  }
  const parts = [`run "${record.runName}"`];
  if (record.project) {
    parts.push(`project "${record.project}"`);
  }
  parts.push(`pid ${record.pid}`);
  if (record.startedAt) {
    parts.push(`since ${new Date(record.startedAt).toLocaleTimeString()}`);
  }
  if (record.cwd) {
    parts.push(`in ${record.cwd}`);
  }
  return parts.join(', ');
}
