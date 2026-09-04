import { type ChildProcess } from 'child_process';

import { type FullConfig } from '@playwright/test';

import { logger } from './logger';
import { createDeviceProvider } from './providers';
import {
  ensureDriverInstalled,
  findFreePort,
  startAppiumServer,
  stopAppiumServer,
} from './providers/appium';
import { shutdownBootedEmulators } from './providers/emulator/boot';
import { APPIUM_PORT_ENV, resolveDeviceEntries } from './providers/slots';
import { AppwrightConfig, Platform } from './types';

const LOCAL_PROVIDERS = ['local-device', 'emulator'];

async function globalSetup(config: FullConfig<AppwrightConfig>) {
  const args = process.argv;
  const projects: string[] = [];
  args.forEach((arg, index) => {
    if (arg === '--project') {
      const project = args[index + 1];
      if (project) {
        projects.push(project);
      } else {
        throw new Error('Project name is required with --project flag');
      }
    }
  });

  if (projects.length == 0) {
    // Capability to run all projects is not supported currently
    // This will be added after support for using same appium server for multiple projects is added
    throw new Error(
      'Capability to run all projects is not supported. Please specify the project name with --project flag.',
    );
  }

  // One Appium server is shared by every local project selected for this run.
  let appiumProcess: ChildProcess | undefined;
  let usedEmulatorProvider = false;

  for (let i = 0; i < config.projects.length; i++) {
    const project = config.projects[i]!;
    if (!projects.includes(project.name)) {
      continue;
    }
    const provider = createDeviceProvider(project);
    await provider.globalSetup?.({ workers: config.workers });

    const providerName = project.use.device?.provider;
    if (!providerName || !LOCAL_PROVIDERS.includes(providerName)) {
      continue;
    }
    if (providerName === 'emulator') {
      usedEmulatorProvider = true;
    }

    const entries = resolveDeviceEntries(project.use.device as any);
    const available = entries.length === 0 ? 1 : entries.length;
    if (config.workers > available) {
      throw new Error(
        `workers (${config.workers}) exceeds configured devices (${available}) for project ` +
          `"${project.name}". Add entries to \`device.devices\` or set \`workers: ${available}\`.`,
      );
    }

    const platform = project.use.platform;
    await ensureDriverInstalled(platform === Platform.ANDROID ? 'uiautomator2' : 'xcuitest');

    if (!appiumProcess) {
      const port = await findFreePort();
      appiumProcess = await startAppiumServer(port);
      process.env[APPIUM_PORT_ENV] = String(port);
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
