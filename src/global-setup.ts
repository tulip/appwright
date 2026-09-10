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
import { shutdownBootedEmulators } from './providers/emulator/boot';
import { APPIUM_PORT_ENV, resolveDeviceEntries } from './providers/slots';
import { parseProjectsFromArgv, resolveRunName } from './run-name';
import { AppwrightConfig, Platform } from './types';

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

  // One Appium server is shared by every local project selected for this run.
  let appiumProcess: ChildProcess | undefined;
  let usedEmulatorProvider = false;

  for (let i = 0; i < config.projects.length; i++) {
    const project = config.projects[i]!;
    if (!projects.includes(project.name)) {
      continue;
    }
    const providerName = project.use.device?.provider;
    const isLocalProvider = !!providerName && LOCAL_PROVIDERS.includes(providerName);

    if (isLocalProvider) {
      // Fail fast on a workers/devices mismatch before booting anything.
      const entries = resolveDeviceEntries(project.use.device as any);
      const available = entries.length === 0 ? 1 : entries.length;
      if (config.workers > available) {
        throw new Error(
          `workers (${config.workers}) exceeds configured devices (${available}) for project ` +
            `"${project.name}". Add entries to \`device.devices\` or set \`workers: ${available}\`.`,
        );
      }
    }

    const provider = createDeviceProvider(project);
    await provider.globalSetup?.({ workers: config.workers });

    if (!isLocalProvider) {
      continue;
    }
    if (providerName === 'emulator') {
      usedEmulatorProvider = true;
    }

    const platform = project.use.platform;
    await ensureDriverInstalled(platform === Platform.ANDROID ? 'uiautomator2' : 'xcuitest');

    if (!appiumProcess) {
      const server = await startAppiumServerOnFreePort();
      appiumProcess = server.process;
      process.env[APPIUM_PORT_ENV] = String(server.port);
    }
  }

  return async () => {
    if (appiumProcess) {
      try {
        await stopAppiumServer(appiumProcess);
      } catch (error: any) {
        logger.error(`Failed to stop Appium server: ${error?.message ?? error}`);
      }
    }
    if (usedEmulatorProvider) {
      try {
        await shutdownBootedEmulators();
      } catch (error: any) {
        logger.error(`Failed to shut down emulators: ${error?.message ?? error}`);
      }
    }
  };
}

export default globalSetup;
