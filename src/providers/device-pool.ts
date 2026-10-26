import net from 'net';

import { logger } from '../logger';
import { DeviceEntry, LeasedDevice } from '../types';
import { Availability, DeviceKind, probeAvailability } from './availability';
import {
  avdLeaseKey,
  describeHolder,
  deviceLeaseKey,
  LeaseOwner,
  LeaseRecord,
  LeaseStore,
  portSlotLeaseKey,
} from './leases';
import { MAX_PORT_SLOTS, portsForSlot } from './slots';

/** Pins a run to one device by udid or name. Set by `appwright test --device <udid|name>`. */
export const DEVICE_ENV = 'APPWRIGHT_DEVICE';
/** Seconds to wait for a busy device to be released. Set by `--wait-for-device <seconds>`. */
export const WAIT_FOR_DEVICE_ENV = 'APPWRIGHT_WAIT_FOR_DEVICE';
/** JSON `{ [project]: LeasedDevice[] }` through which globalSetup hands leases to the workers. */
export const LEASED_DEVICES_ENV = 'APPWRIGHT_LEASED_DEVICES';

const WAIT_POLL_MS = 2000;
const PORT_PROBE_TIMEOUT_MS = 500;

/** `true` when something accepts connections on `127.0.0.1:port`. */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code !== 'ECONNREFUSED');
    });
  });
}

/** Port slots with at least one port that another program already listens on. */
export async function findBusyPortSlots(
  inUse: (port: number) => Promise<boolean> = isPortInUse,
): Promise<Set<number>> {
  const slots = Array.from({ length: MAX_PORT_SLOTS }, (_, slot) => slot);
  const busy = await Promise.all(
    slots.map(async (slot) => (await Promise.all(portsForSlot(slot).map(inUse))).some(Boolean)),
  );
  return new Set(slots.filter((slot) => busy[slot]));
}

/** One selected local project, as globalSetup sees it. */
export type PoolProject = {
  name: string;
  kind: DeviceKind;
  /** Configured pool, in config order. Empty for legacy configs with no `udid`/`devices`. */
  pool: DeviceEntry[];
  /** How many devices this run needs from the pool. */
  count: number;
};

export class DeviceSelectionError extends Error {
  /** `true` when the failure is only because other runs hold devices, so waiting can help. */
  readonly retriable: boolean;

  constructor(message: string, retriable = false) {
    super(message);
    this.name = 'DeviceSelectionError';
    this.retriable = retriable;
    // Playwright prints the stack of a failed globalSetup; the message is the whole story.
    this.stack = `${this.name}: ${message}`;
  }
}

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ');
}

function describeEntry(entry: DeviceEntry, availability?: Availability): string {
  const name = entry.name ?? availability?.name ?? entry.avd;
  return name && name !== entry.udid ? `${entry.udid} (${name})` : entry.udid;
}

/**
 * Finds the pool entry `--device` names: an exact udid first, otherwise the entry's `name`, its
 * `avd`, or the name the platform reports for it (case-insensitive, `_` and spaces equivalent).
 */
export function matchPinnedDevice(
  pinned: string,
  pool: DeviceEntry[],
  availability: Map<string, Availability>,
  projectName: string,
): DeviceEntry {
  const byUdid = pool.find((entry) => entry.udid.toLowerCase() === pinned.trim().toLowerCase());
  if (byUdid) {
    return byUdid;
  }
  const wanted = normalizeName(pinned);
  const matches = pool.filter((entry) =>
    [entry.name, entry.avd, availability.get(entry.udid)?.name, availability.get(entry.udid)?.avd]
      .filter((candidate): candidate is string => !!candidate)
      .some((candidate) => normalizeName(candidate) === wanted),
  );
  if (matches.length === 1) {
    return matches[0]!;
  }
  const listing = pool
    .map((entry) => `  - ${describeEntry(entry, availability.get(entry.udid))}`)
    .join('\n');
  if (matches.length > 1) {
    throw new DeviceSelectionError(
      `--device "${pinned}" matches ${matches.length} devices in project "${projectName}": ` +
        `${matches.map((entry) => entry.udid).join(', ')}. Pass the udid instead.`,
    );
  }
  throw new DeviceSelectionError(
    `--device "${pinned}" is not in the device pool of project "${projectName}". ` +
      `Configured devices:\n${listing}`,
  );
}

/** Lease keys an entry needs: its udid, plus its AVD for Android emulators. */
export function leaseKeysFor(
  kind: DeviceKind,
  entry: DeviceEntry,
  availability: Availability | undefined,
): string[] {
  const keys = [deviceLeaseKey(entry.udid)];
  const avd = availability?.avd ?? entry.avd;
  if (kind === 'android-emulator' && avd) {
    keys.push(avdLeaseKey(avd));
  }
  return keys;
}

/**
 * Chooses the entries a project leases, given a snapshot of availability and current holders.
 * Pure: `holderOf` returns who holds a lease key (another run, or another project of this run).
 */
export function planSelection(options: {
  project: PoolProject;
  availability: Map<string, Availability>;
  holderOf: (key: string) => string | undefined;
  pinned?: string;
}): DeviceEntry[] {
  const { project, availability, holderOf, pinned } = options;
  const holderOfEntry = (entry: DeviceEntry) =>
    leaseKeysFor(project.kind, entry, availability.get(entry.udid))
      .map(holderOf)
      .find((holder) => holder !== undefined);

  if (pinned !== undefined) {
    const entry = matchPinnedDevice(pinned, project.pool, availability, project.name);
    const status = availability.get(entry.udid);
    // Busy first: a device another run is booting or using often looks offline too.
    const holder = holderOfEntry(entry);
    if (holder) {
      throw new DeviceSelectionError(
        `--device "${pinned}": ${describeEntry(entry, status)} is in use by ${holder}.`,
        true,
      );
    }
    if (!status?.usable) {
      throw new DeviceSelectionError(
        `--device "${pinned}": ${describeEntry(entry, status)} is not available: ` +
          `${status?.reason ?? 'unknown state'}.`,
      );
    }
    return [entry];
  }

  const selected: DeviceEntry[] = [];
  const problems: string[] = [];
  let busy = false;
  for (const entry of project.pool) {
    const status = availability.get(entry.udid);
    const holder = holderOfEntry(entry);
    if (holder) {
      busy = true;
      problems.push(`  - ${describeEntry(entry, status)}: in use by ${holder}`);
    } else if (!status?.usable) {
      problems.push(`  - ${describeEntry(entry, status)}: ${status?.reason ?? 'unknown state'}`);
    } else if (selected.length < project.count) {
      selected.push(entry);
    }
  }
  if (selected.length < project.count) {
    throw new DeviceSelectionError(
      `Project "${project.name}" needs ${project.count} device(s) but only ${selected.length} ` +
        `of ${project.pool.length} in its pool can be used:\n${problems.join('\n')}\n` +
        'Free a device, add entries to `device.devices`, lower `workers`' +
        (busy ? ', or wait for one with `--wait-for-device <seconds>`.' : '.'),
      busy,
    );
  }
  return selected;
}

/** The leases one `appwright test` run holds. */
export class RunLeases {
  private released = false;

  constructor(
    readonly byProject: Record<string, LeasedDevice[]>,
    readonly keys: string[],
    private readonly store: LeaseStore,
  ) {}

  /** Releases every lease of this run. Idempotent and never throws. */
  release() {
    if (this.released) {
      return;
    }
    this.released = true;
    try {
      this.store.release(this.keys);
    } catch (error: any) {
      logger.error(`Failed to release device leases: ${error?.message ?? error}`);
    }
  }

  toEnv(): string {
    return JSON.stringify(this.byProject);
  }
}

/**
 * Leases devices and port slots for every selected local project, all or nothing, before anything
 * boots. With `pinned`, the single selected project gets exactly that device. Retries while every
 * failure is a busy device and `waitSeconds` has not run out.
 */
export async function leaseRunDevices(
  projects: PoolProject[],
  options: {
    runName: string;
    workers: number;
    pinned?: string;
    waitSeconds?: number;
    store?: LeaseStore;
    probe?: (kind: DeviceKind, entries: DeviceEntry[]) => Promise<Map<string, Availability>>;
    portInUse?: (port: number) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<RunLeases> {
  const store = options.store ?? new LeaseStore();
  const probe = options.probe ?? probeAvailability;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const { pinned } = options;

  if (pinned !== undefined) {
    if (projects.length !== 1) {
      throw new DeviceSelectionError(
        `--device pins one device, but ${projects.length} local projects are selected ` +
          `(${projects.map((project) => project.name).join(', ')}). Select one with --project.`,
      );
    }
    const project = projects[0]!;
    if (project.pool.length === 0) {
      throw new DeviceSelectionError(
        `--device needs a device pool, but project "${project.name}" configures no ` +
          '`device.udid` or `device.devices`.',
      );
    }
    if (options.workers > 1) {
      throw new DeviceSelectionError(
        `--device pins the run to one device, but \`workers\` is ${options.workers}. ` +
          'Pass --workers 1.',
      );
    }
  }

  for (const project of projects) {
    if (project.pool.length === 0) {
      logger.warn(
        `Project "${project.name}" configures no \`device.udid\` or \`device.devices\`, so the ` +
          'device is picked automatically and cannot be reserved. Two concurrent runs of it may ' +
          'drive the same device; configure a device pool to run concurrently.',
      );
    }
  }

  const deadline = Date.now() + Math.max(0, options.waitSeconds ?? 0) * 1000;
  let announcedWait = false;
  for (;;) {
    const availability = new Map<string, Map<string, Availability>>();
    for (const project of projects) {
      availability.set(project.name, await probe(project.kind, project.pool));
    }
    const busyPortSlots = await findBusyPortSlots(options.portInUse);
    try {
      return acquire(store, projects, availability, busyPortSlots, options.runName, pinned);
    } catch (error) {
      if (!(error instanceof DeviceSelectionError) || !error.retriable || Date.now() >= deadline) {
        throw error;
      }
      if (!announcedWait) {
        logger.log(
          `${error.message.split('\n')[0]} Waiting up to ` +
            `${Math.ceil((deadline - Date.now()) / 1000)} s for it to be released...`,
        );
        announcedWait = true;
      }
      await sleep(Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  }
}

function acquire(
  store: LeaseStore,
  projects: PoolProject[],
  availability: Map<string, Map<string, Availability>>,
  busyPortSlots: Set<number>,
  runName: string,
  pinned: string | undefined,
): RunLeases {
  return store.withMutex(() => {
    const takenBy = new Map<string, string>();
    const holderOf = (key: string): string | undefined => {
      const ours = takenBy.get(key);
      if (ours) {
        return ours;
      }
      const record: LeaseRecord | undefined = store.read(key);
      return record ? describeHolder(record) : undefined;
    };
    const nextPortSlot = (): number => {
      for (let slot = 0; slot < MAX_PORT_SLOTS; slot++) {
        const key = portSlotLeaseKey(slot);
        if (!busyPortSlots.has(slot) && !takenBy.has(key) && !store.read(key)) {
          return slot;
        }
      }
      throw new DeviceSelectionError(
        `All ${MAX_PORT_SLOTS} Appium port slots on this host are leased by other runs or ` +
          'have ports another program listens on.',
        true,
      );
    };

    const plan: Array<{ project: string; keys: string[] }> = [];
    const byProject: Record<string, LeasedDevice[]> = {};
    for (const project of projects) {
      const projectAvailability = availability.get(project.name)!;
      const leased: LeasedDevice[] = [];
      const take = (keys: string[]) => {
        for (const key of keys) {
          takenBy.set(key, `project "${project.name}" of this run`);
        }
        plan.push({ project: project.name, keys });
      };

      if (project.pool.length === 0) {
        const portSlot = nextPortSlot();
        take([portSlotLeaseKey(portSlot)]);
        leased.push({ portSlot });
      } else {
        const entries = planSelection({
          project,
          availability: projectAvailability,
          holderOf,
          pinned,
        });
        for (const entry of entries) {
          const status = projectAvailability.get(entry.udid);
          take(leaseKeysFor(project.kind, entry, status));
          const portSlot = nextPortSlot();
          take([portSlotLeaseKey(portSlot)]);
          leased.push({
            udid: entry.udid,
            ...((status?.avd ?? entry.avd) && { avd: status?.avd ?? entry.avd }),
            ...((entry.name ?? status?.name) && { name: entry.name ?? status?.name }),
            portSlot,
            online: status?.state === 'online',
          });
        }
      }
      byProject[project.name] = leased;
    }

    const startedAt = new Date().toISOString();
    const keys: string[] = [];
    for (const { project, keys: projectKeys } of plan) {
      const owner: LeaseOwner = {
        pid: process.pid,
        runName,
        project,
        cwd: process.cwd(),
        startedAt,
      };
      for (const key of projectKeys) {
        store.write(key, owner);
        keys.push(key);
      }
    }
    for (const [project, devices] of Object.entries(byProject)) {
      const described = devices.map((device) =>
        device.udid
          ? `${device.udid}${device.name ? ` (${device.name})` : ''} [port slot ${device.portSlot}]`
          : `auto-picked device [port slot ${device.portSlot}]`,
      );
      logger.log(`Project "${project}" leased ${described.join(', ')}.`);
    }
    return new RunLeases(byProject, keys, store);
  });
}

/**
 * Releases the run's leases however the process ends: on `exit`, and on SIGINT/SIGTERM/SIGHUP when
 * nothing else handles the signal (Playwright handles SIGINT itself and runs global teardown, which
 * releases them after shutting devices down; `exit` stays as the backstop). Returns an uninstaller.
 */
export function releaseOnExit(leases: RunLeases): () => void {
  const onExit = () => leases.release();
  const signals: Array<[NodeJS.Signals, number]> = [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ];
  const handlers = signals.map(([signal, code]) => {
    const handler = () => {
      if (process.listenerCount(signal) === 1) {
        leases.release();
        process.exit(code);
      }
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  process.on('exit', onExit);
  return () => {
    process.off('exit', onExit);
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}

/** Reads the leases globalSetup published for the workers. */
export function readLeasedDevices(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, LeasedDevice[]> {
  const raw = env[LEASED_DEVICES_ENV];
  if (!raw) {
    throw new Error(
      `Device leases not found in ${LEASED_DEVICES_ENV}. Is the Appwright globalSetup running? ` +
        'Make sure the config is created with `defineConfig` from appwright.',
    );
  }
  return JSON.parse(raw) as Record<string, LeasedDevice[]>;
}

/**
 * The device worker slot `slot` (Playwright `parallelIndex`) of `projectName` drives. A
 * replacement worker started after a failure keeps its `parallelIndex`, so it gets the same device.
 */
export function getLeasedDeviceForSlot(
  projectName: string,
  slot: number,
  env: NodeJS.ProcessEnv = process.env,
): LeasedDevice {
  if (!Number.isInteger(slot) || slot < 0) {
    throw new Error(`Worker slot must be a non-negative integer, got ${slot}.`);
  }
  const leased = readLeasedDevices(env)[projectName];
  if (!leased) {
    throw new Error(`No devices were leased for project "${projectName}" in globalSetup.`);
  }
  const device = leased[slot];
  if (device) {
    return device;
  }
  if (leased.length === 1 && !leased[0]!.udid) {
    throw new Error(
      `Worker slot ${slot} has no device. Running more than one worker requires listing the ` +
        'devices in the config, e.g. `device: { devices: [{ udid: "..." }, { udid: "..." }] }`, ' +
        'or set `workers: 1`.',
    );
  }
  throw new Error(
    `Worker slot ${slot} has no device: this run leased ${leased.length} device(s) for project ` +
      `"${projectName}". Add entries to \`device.devices\` or lower \`workers\`.`,
  );
}
