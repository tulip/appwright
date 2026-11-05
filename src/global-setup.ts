import { type ChildProcess } from 'child_process';
import path from 'path';

import { type FullConfig } from '@playwright/test';

import { logger } from './logger';
import { createDeviceProvider } from './providers';
import {
  ensureDriverInstalled,
  startAppiumServerOnFreePort,
  stopAppiumServer,
} from './providers/appium';
import { deviceKind } from './providers/availability';
import {
  DEVICE_ENV,
  LEASED_DEVICES_ENV,
  leaseRunDevices,
  PoolProject,
  releaseOnExit,
  RunLeases,
  WAIT_FOR_DEVICE_ENV,
} from './providers/device-pool';
import { shutdownBootedEmulators } from './providers/emulator/boot';
import { APPIUM_PORT_ENV, assertWorkersFitDevices, resolveDeviceEntries } from './providers/slots';
import { parseProjectsFromArgv, resolveRunName } from './run-name';
import { AppwrightConfig, EmulatorConfig, LocalDeviceConfig, Platform } from './types';

const LOCAL_PROVIDERS = ['local-device', 'emulator'];

/**
 * One log line saying where this run's results go, so that interleaved output from several
 * concurrent runs in one terminal can be told apart.
 */
function logRunLocation(config: FullConfig<AppwrightConfig>, projects: string[]) {
  const runName = resolveRunName();
  const selected = config.projects.filter((project) => projects.includes(project.name));
  const outputDirs = [...new Set(selected.map((project) => project.outputDir))].map((dir) =>
    path.relative(process.cwd(), dir),
  );
  const htmlReporter = config.reporter.find(([name]) => name === 'html');
  const reportDir: string | undefined = htmlReporter?.[1]?.outputFolder;
  const parts = [`test output in ${outputDirs.join(', ')}`];
  if (reportDir) {
    parts.push(`HTML report in ${path.relative(process.cwd(), reportDir)}`);
  }
  logger.log(`Run "${runName}": ${parts.join(', ')}`);
}

/** `--wait-for-device` seconds from the environment; 0 (fail fast) when unset. */
export function parseWaitSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return 0;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(
      `${WAIT_FOR_DEVICE_ENV} must be a non-negative number of seconds, got "${raw}".`,
    );
  }
  return seconds;
}

async function globalSetup(config: FullConfig<AppwrightConfig>) {
  const projects = parseProjectsFromArgv(process.argv);

  if (projects.length == 0) {
    // Capability to run all projects is not supported currently
    // This will be added after support for using same appium server for multiple projects is added
    throw new Error(
      'Capability to run all projects is not supported. Please specify the project name with --project flag.',
    );
  }

  logRunLocation(config, projects);

  const selected = config.projects.filter((project) => projects.includes(project.name));
  const isLocal = (project: (typeof selected)[number]) => {
    const providerName = project.use.device?.provider;
    return !!providerName && LOCAL_PROVIDERS.includes(providerName);
  };

  // Reserve every device this run will drive before anything boots or Appium starts, so a busy or
  // missing device fails the run straight away and concurrent runs never share a device.
  const poolProjects: PoolProject[] = selected.filter(isLocal).map((project) => {
    const device = project.use.device as LocalDeviceConfig | EmulatorConfig;
    // Fail fast on a workers/devices mismatch before booting anything.
    assertWorkersFitDevices(device, config.workers, project.name);
    const pool = resolveDeviceEntries(device);
    return {
      name: project.name,
      kind: deviceKind(device.provider, project.use.platform!),
      pool,
      count: pool.length === 0 ? 1 : Math.min(config.workers, pool.length),
    };
  });
  const pinned = process.env[DEVICE_ENV]?.trim() || undefined;
  if (pinned && poolProjects.length === 0) {
    throw new Error(
      `--device "${pinned}" only applies to the local-device and emulator providers, but none of ` +
        `the selected projects (${projects.join(', ')}) uses one.`,
    );
  }
  let leases: RunLeases | undefined;
  let stopReleasingOnExit: (() => void) | undefined;
  if (poolProjects.length > 0) {
    leases = await leaseRunDevices(poolProjects, {
      runName: resolveRunName(),
      workers: config.workers,
      pinned,
      waitSeconds: parseWaitSeconds(process.env[WAIT_FOR_DEVICE_ENV]),
    });
    stopReleasingOnExit = releaseOnExit(leases);
    process.env[LEASED_DEVICES_ENV] = leases.toEnv();
  }

  // One Appium server is shared by every local project selected for this run.
  let appiumProcess: ChildProcess | undefined;

  // Order matters: the leases go last, so no other run takes a device while it is shutting down.
  const teardown = async () => {
    if (appiumProcess) {
      try {
        await stopAppiumServer(appiumProcess);
      } catch (error: any) {
        logger.error(`Failed to stop Appium server: ${error?.message ?? error}`);
      }
    }
    try {
      // Only devices this run booted, which are all devices it leased; physical devices are never
      // shut down.
      await shutdownBootedEmulators();
    } catch (error: any) {
      logger.error(`Failed to shut down emulators: ${error?.message ?? error}`);
    }
    leases?.release();
    stopReleasingOnExit?.();
  };

  try {
    for (const project of selected) {
      const provider = createDeviceProvider(project);
      await provider.globalSetup?.({
        workers: config.workers,
        devices: leases?.byProject[project.name],
      });

      if (!isLocal(project)) {
        continue;
      }

      const platform = project.use.platform;
      await ensureDriverInstalled(platform === Platform.ANDROID ? 'uiautomator2' : 'xcuitest');

      if (!appiumProcess) {
        const server = await startAppiumServerOnFreePort();
        appiumProcess = server.process;
        process.env[APPIUM_PORT_ENV] = String(server.port);
      }
    }
  } catch (error) {
    await teardown();
    throw error;
  }

  return teardown;
}

export default globalSetup;
