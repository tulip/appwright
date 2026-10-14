import { FullProject } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { LocalDeviceProvider } from '../providers/local';
import { APPIUM_PORT_ENV } from '../providers/slots';
import { AppwrightConfig, LocalDeviceConfig, Platform } from '../types';

const UDID = '00008110-000000000000001E';

function provider(device: Partial<LocalDeviceConfig>): LocalDeviceProvider {
  const project = {
    use: {
      platform: Platform.IOS,
      buildPath: 'builds/App.ipa',
      device: { provider: 'local-device', udid: UDID, ...device },
    },
  } as unknown as FullProject<AppwrightConfig>;
  return new LocalDeviceProvider(project, undefined);
}

async function capabilities(device: Partial<LocalDeviceConfig>) {
  const config = await provider(device)['createConfig']();
  return config.capabilities as Record<string, unknown>;
}

describe('LocalDeviceProvider capabilities', () => {
  beforeEach(() => {
    process.env[APPIUM_PORT_ENV] = '4723';
  });

  afterEach(() => {
    delete process.env[APPIUM_PORT_ENV];
  });

  test('passes extra capabilities through', async () => {
    const caps = await capabilities({
      updatedWDABundleId: 'co.example.WebDriverAgentRunner',
      capabilities: { 'appium:usePreinstalledWDA': true },
    });
    expect(caps['appium:usePreinstalledWDA']).toBe(true);
    expect(caps['appium:updatedWDABundleId']).toBe('co.example.WebDriverAgentRunner');
    expect(caps['appium:udid']).toBe(UDID);
  });

  test('extra capabilities replace Appwright defaults', async () => {
    const caps = await capabilities({
      capabilities: { 'appium:derivedDataPath': '/tmp/wda', 'appium:newCommandTimeout': 60 },
    });
    expect(caps['appium:derivedDataPath']).toBe('/tmp/wda');
    expect(caps['appium:newCommandTimeout']).toBe(60);
  });

  test('without extra capabilities the defaults are unchanged', async () => {
    const caps = await capabilities({});
    expect(caps).not.toHaveProperty('appium:usePreinstalledWDA');
    expect(caps['appium:newCommandTimeout']).toBe(300);
    expect(String(caps['appium:derivedDataPath'])).toContain('slot-0');
  });
});
