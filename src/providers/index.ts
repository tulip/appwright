import { BrowserStackDeviceProvider } from './browserstack';
import { AppwrightConfig, DeviceProvider } from '../types';
import { LocalDeviceProvider } from './local';
import { EmulatorProvider } from './emulator';
import { FullProject } from '@playwright/test';
import { LambdaTestDeviceProvider } from './lambdatest';

export function getProviderClass(provider: string): any {
  switch (provider) {
    case 'browserstack':
      return BrowserStackDeviceProvider;
    case 'lambdatest':
      return LambdaTestDeviceProvider;
    case 'emulator':
      return EmulatorProvider;
    case 'local-device':
      return LocalDeviceProvider;
    default:
      throw new Error(`Unknown device provider: ${provider}`);
  }
}

/**
 * Creates the device provider for a project.
 *
 * @param slot worker slot (Playwright `parallelIndex`). Local providers use it to pick
 * `device.devices[slot]` and to allocate per-session ports; cloud providers ignore it.
 */
export function createDeviceProvider(
  project: FullProject<AppwrightConfig>,
  slot: number = 0,
): DeviceProvider {
  const provider = project.use.device?.provider;
  const appBundleId = project.use.appBundleId;
  if (!provider) {
    throw new Error('Device provider is not specified in the configuration.');
  }
  const ProviderClass = getProviderClass(provider);
  return new ProviderClass(project, appBundleId, slot);
}
