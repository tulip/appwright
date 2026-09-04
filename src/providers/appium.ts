import {
  ChildProcess,
  exec,
  execFile,
  spawn,
} from 'child_process';
import fs from 'fs/promises';
import net from 'net';
import path from 'path';
import { promisify } from 'util';

import { logger } from '../logger';
import { getLatestBuildToolsVersions } from '../utils';

const execPromise = promisify(exec);
const execFilePromise = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared Appium server lifecycle (one server per run, started in globalSetup).
// ---------------------------------------------------------------------------

const APPIUM_READY_MARKER = 'Appium REST http interface listener started';
const APPIUM_STARTUP_TIMEOUT_MS = 60_000;
const APPIUM_STOP_GRACE_MS = 5_000;

/** The Appium server spawned by this process, killed by the single `process.on('exit')` guard. */
let trackedAppiumProcess: ChildProcess | undefined;
let exitGuardRegistered = false;

function registerExitGuard() {
  if (exitGuardRegistered) {
    return;
  }
  exitGuardRegistered = true;
  process.on('exit', () => {
    const proc = trackedAppiumProcess;
    if (proc && proc.exitCode === null && !proc.killed) {
      logger.log('Main process exiting. Killing Appium server...');
      proc.kill('SIGKILL');
    }
  });
}

function listenOn(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => {
      server.close();
      reject(error);
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const assigned = typeof address === 'object' && address ? address.port : port;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
        } else {
          resolve(assigned);
        }
      });
    });
  });
}

/**
 * Returns a free TCP port on 127.0.0.1, preferring `preferred` when it is available.
 */
export async function findFreePort(preferred: number = 4723): Promise<number> {
  try {
    return await listenOn(preferred);
  } catch (error: any) {
    if (error?.code !== 'EADDRINUSE') {
      throw error;
    }
    logger.warn(`Port ${preferred} is in use; picking a free port for the Appium server.`);
    return listenOn(0);
  }
}

function forwardLines(prefix: string, data: Buffer, log: (...args: any[]) => void) {
  const lines = data
    .toString()
    .split('\n')
    .filter((line) => line.trim().length > 0);
  for (const line of lines) {
    log(`${prefix} ${line}`);
  }
}

/**
 * Spawns one Appium server on `port` and resolves with the child process once the REST
 * listener is up. Rejects on EADDRINUSE, spawn errors, or if the process exits before it is ready.
 * Never passes `--session-override` (it would delete every other live session on a new session).
 */
export async function startAppiumServer(port: number): Promise<ChildProcess> {
  return new Promise<ChildProcess>((resolve, reject) => {
    let settled = false;
    // https://github.com/appium/appium-uiautomator2-driver?tab=readme-ov-file#automatic-discovery-of-compatible-chromedriver
    const appiumProcess = spawn(
      'npx',
      ['appium', '--port', String(port), '--allow-insecure=uiautomator2:chromedriver_autodownload'],
      {
        stdio: 'pipe',
      },
    );
    trackedAppiumProcess = appiumProcess;
    registerExitGuard();

    const timeout = setTimeout(() => {
      const seconds = APPIUM_STARTUP_TIMEOUT_MS / 1000;
      fail(new Error(`Appium server did not start within ${seconds} s on port ${port}.`));
      appiumProcess.kill('SIGKILL');
    }, APPIUM_STARTUP_TIMEOUT_MS);

    function fail(error: Error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      logger.error(`Appium: ${error.message}`);
      reject(error);
    }

    function succeed() {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      logger.log(`Appium server is up and running on port ${port}.`);
      resolve(appiumProcess);
    }

    function inspectOutput(output: string) {
      if (output.includes('EADDRINUSE')) {
        fail(
          new Error(
            `Port ${port} is already in use. Stop the process listening on it before running tests.`,
          ),
        );
        appiumProcess.kill('SIGKILL');
        return;
      }
      if (output.includes(APPIUM_READY_MARKER)) {
        succeed();
      }
    }

    appiumProcess.stdout?.on('data', (data: Buffer) => {
      forwardLines('[Appium]', data, logger.log.bind(logger));
      inspectOutput(data.toString());
    });
    appiumProcess.stderr?.on('data', (data: Buffer) => {
      forwardLines('[Appium]', data, logger.warn.bind(logger));
      inspectOutput(data.toString());
    });

    appiumProcess.on('error', (error) => {
      fail(new Error(`Failed to spawn Appium server: ${error.message}`));
    });

    appiumProcess.on('exit', (code, signal) => {
      if (trackedAppiumProcess === appiumProcess) {
        trackedAppiumProcess = undefined;
      }
      logger.log(`Appium server exited with code ${code}${signal ? ` (signal ${signal})` : ''}`);
      fail(new Error(`Appium server exited before it was ready (code ${code}, signal ${signal}).`));
    });
  });
}

/**
 * Stops the given Appium server process: SIGTERM, wait up to 5 s, then SIGKILL.
 * Always resolves; failures are logged.
 */
export async function stopAppiumServer(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    logger.log('Appium server already stopped.');
    return;
  }
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(killTimer);
      resolve();
    };
    const killTimer = setTimeout(() => {
      const seconds = APPIUM_STOP_GRACE_MS / 1000;
      logger.warn(`Appium server did not exit within ${seconds} s; sending SIGKILL.`);
      try {
        proc.kill('SIGKILL');
      } catch (error: any) {
        logger.error(`Error killing Appium server: ${error?.message ?? error}`);
        finish();
      }
    }, APPIUM_STOP_GRACE_MS);
    proc.once('exit', () => {
      logger.log('Appium server stopped successfully.');
      finish();
    });
    try {
      proc.kill('SIGTERM');
    } catch (error: any) {
      logger.error(`Error stopping Appium server: ${error?.message ?? error}`);
      finish();
    }
  });
  if (trackedAppiumProcess === proc) {
    trackedAppiumProcess = undefined;
  }
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON object found in output: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * Installs the Appium driver only if `appium driver list --installed --json` does not list it.
 * Never uninstalls.
 */
export async function ensureDriverInstalled(driver: 'uiautomator2' | 'xcuitest'): Promise<void> {
  let installed: Record<string, unknown> = {};
  try {
    const { stdout } = await execFilePromise('npx', [
      'appium',
      'driver',
      'list',
      '--installed',
      '--json',
    ]);
    installed = extractJsonObject(stdout);
  } catch (error: any) {
    logger.warn(
      `Could not read installed Appium drivers (${error?.message ?? error}); attempting install.`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(installed, driver)) {
    logger.log(`Appium driver "${driver}" is already installed.`);
    return;
  }
  logger.log(`Installing Appium driver "${driver}"...`);
  await new Promise<void>((resolve, reject) => {
    const installProcess = spawn('npx', ['appium', 'driver', 'install', driver], {
      stdio: 'pipe',
    });
    installProcess.stdout?.on('data', (data: Buffer) => {
      forwardLines('[Appium driver]', data, logger.log.bind(logger));
    });
    installProcess.stderr?.on('data', (data: Buffer) => {
      forwardLines('[Appium driver]', data, logger.warn.bind(logger));
    });
    installProcess.on('error', (error) => {
      reject(new Error(`Failed to run appium driver install: ${error.message}`));
    });
    installProcess.on('exit', (code) => {
      if (code === 0) {
        logger.log(`Appium driver "${driver}" installed.`);
        resolve();
      } else {
        reject(new Error(`appium driver install ${driver} exited with code ${code}.`));
      }
    });
  });
}

/**
 * GET /status on the server; true when it answers 200 with `value.ready`.
 */
export async function isAppiumHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`);
    if (!response.ok) {
      return false;
    }
    const body: any = await response.json();
    return body?.value?.ready === true;
  } catch {
    return false;
  }
}

export function getAppBundleId(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let command: string;

    const absolutePath = path.resolve(filePath);

    if (filePath.endsWith('.ipa')) {
      // Stream Info.plist from ZIP to plutil
      command = `unzip -p "${absolutePath}" "Payload/*.app/Info.plist" | plutil -convert xml1 -o - - | grep -A1 "CFBundleIdentifier" | grep string | sed 's/<[^>]*>//g'`;
    } else if (filePath.endsWith('.app')) {
      // Use plutil -extract for .app folders
      const plistPath = path.join(absolutePath, 'Info.plist');
      command = `plutil -extract CFBundleIdentifier raw "${plistPath}"`;
    } else {
      return reject(new Error('Unsupported file type. Use .app or .ipa'));
    }

    exec(command, (error, stdout, stderr) => {
      if (error) return reject(new Error(`Failed to get ID: ${error.message} : ${stderr}`));
      const bundleId = stdout.trim();
      bundleId ? resolve(bundleId) : reject(new Error('Bundle ID empty'));
    });
  });
}

export async function getConnectedIOSDeviceUDID(deviceName?: string): Promise<string> {
  try {
    const { stdout } = await execPromise(`xcrun xctrace list devices`);
    const lines = stdout.split('\n');

    const realDevices: Array<{ name: string; udid: string }> = [];
    let inDevicesSection = false;

    for (const line of lines) {
      // Start of "== Devices ==" section (online devices only)
      if (line.includes('== Devices ==')) {
        inDevicesSection = true;
        continue;
      }

      // Stop when we hit another section
      if (line.includes('==') && inDevicesSection) {
        break;
      }

      // Only process lines in the Devices section
      if (!inDevicesSection) {
        continue;
      }

      // the output from above looks like this: User’s iPhone (18.0) (00003110-002A304e3A53C41E)
      // where `00003110-000A304e3A53C41E` is the UDID of the device
      const match = line.match(/^(.+?)\s+\([\d.]+\)(?:\s+-\s+\w+)?\s+\(([0-9A-Fa-f-]+)\)\s*$/);

      if (match) {
        const name = match[1]!.trim();
        const udid = match[2]!;

        realDevices.push({ name, udid });
      }
    }

    if (realDevices.length === 0) {
      throw new Error(
        `No connected iOS devices detected. Please ensure your device is connected and try again.`,
      );
    }

    // If deviceName provided, find exact match
    if (deviceName) {
      const device = realDevices.find((d) => d.name === deviceName);
      if (!device) {
        throw new Error(
          `No iOS device found with name "${deviceName}". Available devices: ${realDevices
            .map((d) => d.name)
            .join(', ')}`,
        );
      }
      return device.udid;
    }

    // Return first available device
    return realDevices[0]!.udid;
  } catch (error) {
    //@ts-ignore
    throw new Error(`getConnectedIOSDeviceUDID: ${error.message}`);
  }
}

export async function getActiveAndroidDevices(): Promise<number> {
  try {
    const { stdout } = await execPromise('adb devices');

    const lines = stdout.trim().split('\n');

    const deviceLines = lines.filter((line) => line.includes('\tdevice'));

    return deviceLines.length;
  } catch (error) {
    throw new Error(
      //@ts-ignore
      `getActiveAndroidDevices: ${error.message}`,
    );
  }
}
async function getLatestBuildToolsVersion(): Promise<string | undefined> {
  const androidHome = process.env.ANDROID_HOME;
  const buildToolsPath = path.join(androidHome!, 'build-tools');
  try {
    const files = await fs.readdir(buildToolsPath);

    const versions = files.filter((file) => /^\d+\.\d+\.\d+(-rc\d+)?$/.test(file));

    if (versions.length === 0) {
      throw new Error(
        `No valid build-tools found in ${buildToolsPath}. Please download from Android Studio: https://developer.android.com/studio/intro/update#required`,
      );
    }

    return getLatestBuildToolsVersions(versions);
  } catch (err) {
    logger.error(`getLatestBuildToolsVersion: ${err}`);
    throw new Error(
      `Error reading ${buildToolsPath}. Ensure it exists or download from Android Studio: https://developer.android.com/studio/intro/update#required`,
    );
  }
}

export async function getApkDetails(buildPath: string): Promise<{
  packageName: string | undefined;
  launchableActivity: string | undefined;
}> {
  const androidHome = process.env.ANDROID_HOME;
  const buildToolsVersion = await getLatestBuildToolsVersion();

  if (!buildToolsVersion) {
    throw new Error(
      `No valid build-tools found in ${buildToolsVersion}. Please download from Android Studio: https://developer.android.com/studio/intro/update#required`,
    );
  }

  const aaptPath = path.join(androidHome!, 'build-tools', buildToolsVersion!, 'aapt');
  const command = `${aaptPath} dump badging ${buildPath}`;

  try {
    const { stdout, stderr } = await execPromise(command);

    if (stderr) {
      logger.error(`getApkDetails: ${stderr}`);
      throw new Error(`Error executing aapt: ${stderr}`);
    }

    const packageMatch = stdout.match(/package: name='(\S+)'/);
    const activityMatch = stdout.match(/launchable-activity: name='(\S+)'/);

    if (!packageMatch || !activityMatch) {
      throw new Error(
        `Unable to retrieve package or launchable activity from the APK. Please verify that the provided file is a valid APK.`,
      );
    }

    const packageName = packageMatch[1];
    const launchableActivity = activityMatch[1];

    return { packageName, launchableActivity };
  } catch (error: any) {
    throw new Error(`getApkDetails: ${error.message}`);
  }
}
