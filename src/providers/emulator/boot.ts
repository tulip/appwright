import { ChildProcess, execFile, spawn } from 'child_process';
import path from 'path';
import { promisify } from 'util';

import { logger } from '../../logger';
import { DeviceEntry, Platform } from '../../types';
import { emulatorPortFromUdid } from '../slots';

const execFileAsync = promisify(execFile);

/** Overall cap for one device to come online and finish booting. */
const BOOT_TIMEOUT_MS = 5 * 60 * 1000;
/** Interval between `getprop sys.boot_completed` polls. */
const BOOT_POLL_INTERVAL_MS = 2000;
/** Cap for one adb/simctl query that should return quickly. */
const QUERY_TIMEOUT_MS = 30 * 1000;
/**
 * Grace period for an emulator process to exit after `adb emu kill` before it is SIGKILLed.
 * The emulator itself waits up to 20 s to save its snapshot on shutdown, so stay above that.
 */
const SHUTDOWN_GRACE_MS = 45 * 1000;

const EMULATOR_INSTALL_GUIDE =
  'https://community.neptune-software.com/topics/tips--tricks/blogs/how-to-install--android-emulator-without--android--st';

type TrackedEmulator = {
  udid: string;
  child: ChildProcess;
  /** Rejects when the emulator process exits or fails to spawn. Never resolves. */
  exited: Promise<never>;
};

/** Android emulator processes spawned by this process, keyed by udid (`emulator-<port>`). */
const emulatorProcesses = new Map<string, TrackedEmulator>();
/** Udids of devices this process booted. Devices that were already online are never added. */
const bootedByUs = new Set<string>();
/** Platform of every udid in `bootedByUs`, so shutdown knows which tool to use. */
const bootedPlatforms = new Map<string, Platform>();
let exitGuardRegistered = false;

/**
 * Lists installed Android AVDs (`emulator -list-avds`). Throws with installation guidance when
 * none are installed.
 */
export async function listAvds(): Promise<string[]> {
  const emulatorPath = getEmulatorPath();
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execFileAsync(emulatorPath, ['-list-avds'], {
      timeout: QUERY_TIMEOUT_MS,
    }));
  } catch (error) {
    logger.error(`Emulator: ${describeError(error)}`);
    throw new Error(
      `Error fetching emulator list.\nPlease install emulator from Android SDK Tools.\nFollow this guide to install emulators: ${EMULATOR_INSTALL_GUIDE}`,
    );
  }
  if (stderr) {
    logger.error(`Emulator: ${stderr}`);
  }

  // Filter out lines that do not contain device names
  const avds = stdout
    .trim()
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('INFO') && !line.includes('/tmp/'))
    .map((line) => line.trim());

  if (avds.length === 0) {
    throw new Error(
      `No installed emulators found.\nFollow this guide to install emulators: ${EMULATOR_INSTALL_GUIDE}`,
    );
  }
  return avds;
}

/**
 * Whether the device is online: Android checks `adb devices` for `<udid>\tdevice`; iOS checks
 * `xcrun simctl list devices booted -j` for the udid.
 *
 * Returns `false` when the udid is simply not listed; errors from missing or failing tools
 * (adb, xcrun) propagate.
 */
export async function isDeviceOnline(platform: Platform, udid: string): Promise<boolean> {
  if (platform === Platform.ANDROID) {
    const { stdout } = await execFileAsync('adb', ['devices'], { timeout: QUERY_TIMEOUT_MS });
    const onlineLine = new RegExp(`^${escapeRegExp(udid)}\\s+device$`);
    return stdout.split('\n').some((line) => onlineLine.test(line.trim()));
  }

  const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], {
    timeout: QUERY_TIMEOUT_MS,
  });
  const parsed = JSON.parse(stdout) as {
    devices?: Record<string, Array<{ udid?: string; state?: string }>>;
  };
  // The `booted` filter already restricts the list to devices in the Booted state.
  return Object.values(parsed.devices ?? {}).some((runtimeDevices) =>
    runtimeDevices.some((device) => device.udid === udid),
  );
}

/**
 * Boots every entry that is not online yet and waits for it to finish booting.
 * Android boots `emulator -avd <avd> -port <port from udid>`; iOS runs
 * `xcrun simctl bootstatus <udid> -b`. Remembers which devices this process booted.
 * Throws when an Android entry is offline and has no `avd`.
 *
 * All offline entries are launched first and then awaited together. If any of them fails to
 * boot, everything this process booted is shut down again before the error is rethrown, so a
 * failed globalSetup does not leak emulators.
 */
export async function ensureEmulatorsBooted(
  platform: Platform,
  entries: DeviceEntry[],
): Promise<void> {
  const offline: DeviceEntry[] = [];
  for (const entry of entries) {
    if (await isDeviceOnline(platform, entry.udid)) {
      logger.log(`Device "${entry.udid}" is already online; it will be left running afterwards.`);
    } else {
      offline.push(entry);
    }
  }
  if (offline.length === 0) {
    return;
  }

  let waits: Promise<void>[];
  if (platform === Platform.ANDROID) {
    // Validate every entry before launching anything so a bad entry fails fast and cleanly.
    for (const entry of offline) {
      if (!entry.avd) {
        throw new Error(
          `Emulator "${entry.udid}" is not running and has no \`avd\` configured. ` +
            `Add \`avd: "<name>"\` to boot it automatically or start it manually.`,
        );
      }
      emulatorPortFromUdid(entry.udid);
    }
    const emulatorPath = getEmulatorPath();
    const launched = offline.map((entry) => launchAndroidEmulator(emulatorPath, entry));
    waits = launched.map((tracked) => waitForAndroidBoot(tracked));
  } else {
    waits = offline.map((entry) => bootSimulator(entry.udid));
  }

  const results = await Promise.allSettled(waits);
  const failures = results
    .map((result, index) => ({ result, udid: offline[index]!.udid }))
    .filter(({ result }) => result.status === 'rejected')
    .map(
      ({ result, udid }) => `${udid}: ${describeError((result as PromiseRejectedResult).reason)}`,
    );

  if (failures.length > 0) {
    logger.error(
      `Failed to boot ${failures.length} device(s); shutting down the ones this run booted.`,
    );
    await shutdownBootedEmulators();
    throw new Error(`Failed to boot ${failures.length} device(s):\n${failures.join('\n')}`);
  }
}

/**
 * Shuts down only the devices booted by `ensureEmulatorsBooted` in this process.
 * Never throws; failures are logged per device.
 */
export async function shutdownBootedEmulators(): Promise<void> {
  const udids = [...bootedByUs];
  await Promise.all(
    udids.map(async (udid) => {
      try {
        if (bootedPlatforms.get(udid) === Platform.IOS) {
          await shutdownSimulator(udid);
        } else {
          await shutdownAndroidEmulator(udid);
        }
        logger.log(`Shut down device "${udid}".`);
      } catch (error) {
        logger.error(`Failed to shut down device "${udid}": ${describeError(error)}`);
      } finally {
        bootedByUs.delete(udid);
        bootedPlatforms.delete(udid);
      }
    }),
  );
  bootedByUs.clear();
  bootedPlatforms.clear();
}

// ---------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------

function getEmulatorPath(): string {
  const androidHome = process.env.ANDROID_HOME;
  if (!androidHome) {
    throw new Error(
      'ANDROID_HOME is not set. Point it at your Android SDK so the emulator binary can be found.',
    );
  }
  return path.join(androidHome, 'emulator', 'emulator');
}

function launchAndroidEmulator(emulatorPath: string, entry: DeviceEntry): TrackedEmulator {
  const { udid } = entry;
  const port = emulatorPortFromUdid(udid);
  logger.log(`Booting emulator "${udid}" from AVD "${entry.avd}" on port ${port}...`);

  const child = spawn(emulatorPath, ['-avd', entry.avd!, '-port', String(port)], {
    stdio: 'pipe',
    detached: false,
  });

  child.stdout?.on('data', (data: Buffer) => logEmulatorOutput(udid, data, 'log'));
  child.stderr?.on('data', (data: Buffer) => logEmulatorOutput(udid, data, 'warn'));

  const exited = new Promise<never>((_, reject) => {
    child.once('error', (error) => {
      reject(new Error(`Failed to start emulator "${udid}": ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      reject(
        new Error(
          `Emulator "${udid}" exited before boot completed (code ${code}, signal ${signal}).`,
        ),
      );
    });
  });
  // The rejection is observed by whoever races against it; avoid an unhandled rejection when the
  // emulator exits later (e.g. during shutdown) and nobody is waiting anymore.
  exited.catch(() => {});

  child.once('exit', (code, signal) => {
    logger.log(`Emulator[${udid}]: process exited (code ${code}, signal ${signal}).`);
    if (emulatorProcesses.get(udid)?.child === child) {
      emulatorProcesses.delete(udid);
    }
  });

  const tracked: TrackedEmulator = { udid, child, exited };
  emulatorProcesses.set(udid, tracked);
  bootedByUs.add(udid);
  bootedPlatforms.set(udid, Platform.ANDROID);
  registerExitGuard();
  return tracked;
}

async function waitForAndroidBoot(tracked: TrackedEmulator): Promise<void> {
  const { udid, child } = tracked;
  try {
    await Promise.race([waitForBootCompleted(udid), tracked.exited]);
    logger.log(`Emulator "${udid}" booted.`);
  } catch (error) {
    if (isAlive(child)) {
      logger.warn(`Killing emulator "${udid}" after a failed boot.`);
      child.kill('SIGKILL');
    }
    throw error;
  }
}

async function waitForBootCompleted(udid: string): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  const timeoutMessage = `Timed out after ${
    BOOT_TIMEOUT_MS / 60000
  } minutes waiting for emulator "${udid}" to finish booting.`;

  try {
    await execFileAsync('adb', ['-s', udid, 'wait-for-device'], {
      timeout: Math.max(1, deadline - Date.now()),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(timeoutMessage);
    }
    throw new Error(`adb wait-for-device failed for "${udid}": ${describeError(error)}`);
  }

  // The device is visible to adb; now wait for the Android system to report boot completion.
  for (;;) {
    let bootCompleted = '';
    try {
      const { stdout } = await execFileAsync(
        'adb',
        ['-s', udid, 'shell', 'getprop', 'sys.boot_completed'],
        { timeout: QUERY_TIMEOUT_MS },
      );
      bootCompleted = stdout.trim();
    } catch {
      // adb can transiently fail (device offline / restarting adbd) during boot; keep polling.
    }
    if (bootCompleted === '1') {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(timeoutMessage);
    }
    await sleep(Math.min(BOOT_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
}

async function shutdownAndroidEmulator(udid: string): Promise<void> {
  const tracked = emulatorProcesses.get(udid);
  try {
    await execFileAsync('adb', ['-s', udid, 'emu', 'kill'], { timeout: QUERY_TIMEOUT_MS });
  } catch (error) {
    if (!tracked) {
      throw error;
    }
    logger.warn(
      `adb emu kill failed for "${udid}" (${describeError(
        error,
      )}); falling back to killing the process.`,
    );
  }

  if (tracked && isAlive(tracked.child)) {
    const exited = await waitForExit(tracked.child, SHUTDOWN_GRACE_MS);
    if (!exited) {
      logger.warn(
        `Emulator "${udid}" is still running ${
          SHUTDOWN_GRACE_MS / 1000
        } s after emu kill; sending SIGKILL.`,
      );
      tracked.child.kill('SIGKILL');
    }
  }
  emulatorProcesses.delete(udid);
}

function logEmulatorOutput(udid: string, data: Buffer, level: 'log' | 'warn') {
  const lines = data
    .toString()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    logger[level](`Emulator[${udid}]: ${line}`);
  }
}

/** Kill any emulator processes we spawned when the main process exits, registered once. */
function registerExitGuard() {
  if (exitGuardRegistered) {
    return;
  }
  exitGuardRegistered = true;
  process.on('exit', () => {
    for (const [udid, { child }] of emulatorProcesses) {
      if (isAlive(child)) {
        logger.log(`Main process exiting. Killing emulator "${udid}"...`);
        child.kill();
      }
    }
    emulatorProcesses.clear();
  });
}

// ---------------------------------------------------------------------------
// iOS
// ---------------------------------------------------------------------------

async function bootSimulator(udid: string): Promise<void> {
  logger.log(`Booting simulator "${udid}"...`);
  // Recorded before booting so a partially booted simulator is still shut down on failure.
  bootedByUs.add(udid);
  bootedPlatforms.set(udid, Platform.IOS);
  try {
    // `-b` boots the simulator if needed; the command blocks until it has finished booting.
    await execFileAsync('xcrun', ['simctl', 'bootstatus', udid, '-b'], {
      timeout: BOOT_TIMEOUT_MS,
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(
        `Timed out after ${
          BOOT_TIMEOUT_MS / 60000
        } minutes waiting for simulator "${udid}" to boot.`,
      );
    }
    throw new Error(`Failed to boot simulator "${udid}": ${describeError(error)}`);
  }
  logger.log(`Simulator "${udid}" booted.`);
}

async function shutdownSimulator(udid: string): Promise<void> {
  await execFileAsync('xcrun', ['simctl', 'shutdown', udid], { timeout: QUERY_TIMEOUT_MS });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Resolves `true` once the child exits, `false` if it is still running after `timeoutMs`. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isAlive(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `child_process` rejects with `killed: true` when its `timeout` option fires. */
function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { killed?: boolean }).killed === true
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    return stderr ? `${error.message.trim()} (${stderr})` : error.message;
  }
  return String(error);
}
