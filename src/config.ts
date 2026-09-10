import path from 'path';

import {
  defineConfig as defineConfigPlaywright,
  PlaywrightTestConfig,
  ReporterDescription,
} from '@playwright/test';

import { logger } from './logger';
import {
  applyRunNameToReporters,
  DEFAULT_OUTPUT_DIR,
  normalizeReporters,
  resolveRunName,
  runOutputDir,
} from './run-name';
import { AppwrightConfig } from './types';

const resolveGlobalSetup = () => {
  const pathToInstalledAppwright = require.resolve('.');
  const directory = path.dirname(pathToInstalledAppwright);
  return path.join(directory, 'global-setup.js');
};

const resolveVideoReporter = () => {
  const pathToInstalledAppwright = require.resolve('.');
  const directory = path.dirname(pathToInstalledAppwright);
  return path.join(directory, 'reporter.js');
};

const defaultReporters: ReporterDescription[] = [['list'], ['html', { open: 'always' }]];

const defaultConfig: PlaywrightTestConfig<AppwrightConfig> = {
  globalSetup: resolveGlobalSetup(),
  testDir: './tests',
  // This is turned off so that a persistent device fixture can be
  // used across tests in a file where they run sequentially
  fullyParallel: false,
  forbidOnly: false,
  retries: process.env.CI ? 2 : 0,
  // For local-device / emulator runs, `workers` must not exceed the number of entries in
  // `device.devices`: each worker drives its own device (slot = parallelIndex).
  workers: 2,
  use: {
    // TODO: Use this for actions
    actionTimeout: 20_000,
    expectTimeout: 20_000,
  },
  expect: {
    // This is not used right now
    timeout: 20_000,
  },
  timeout: 0,
};

export function defineConfig(config: PlaywrightTestConfig<AppwrightConfig>) {
  const hasGlobalSetup = config.globalSetup !== undefined;
  if (hasGlobalSetup) {
    logger.warn(
      'The `globalSetup` parameter in config will be ignored. See https://github.com/empirical-run/appwright/issues/57',
    );
    delete config.globalSetup;
  }
  // Every run writes into its own folders (`test-results/<run>`, `playwright-report/<run>`) so
  // concurrent runs on one machine do not clobber each other. The name comes from the appwright CLI
  // (`--run-name` / APPWRIGHT_RUN_NAME) or is generated here and inherited by the worker processes.
  const runName = resolveRunName();
  const reporterConfig = normalizeReporters(config.reporter) ?? defaultReporters;
  return defineConfigPlaywright<AppwrightConfig>({
    ...defaultConfig,
    ...config,
    outputDir: runOutputDir(runName, config.outputDir ?? DEFAULT_OUTPUT_DIR),
    reporter: [[resolveVideoReporter()], ...applyRunNameToReporters(reporterConfig, runName)],
    use: {
      ...defaultConfig.use,
      expectTimeout: config.use?.expectTimeout
        ? config.use!.expectTimeout
        : defaultConfig.use?.expectTimeout,
    },
  });
}
