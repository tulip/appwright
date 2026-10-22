import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appiumProcess: { pid: 4242 },
  assertWorkersFitDevices: vi.fn(),
  ensureDriverInstalled: vi.fn(async () => {}),
  startAppiumServerOnFreePort: vi.fn(),
  stopAppiumServer: vi.fn(async () => {}),
  shutdownBootedEmulators: vi.fn(async () => {}),
}));

vi.mock('../providers', () => ({
  createDeviceProvider: () => ({ globalSetup: async () => {} }),
}));
vi.mock('../providers/appium', () => ({
  ensureDriverInstalled: mocks.ensureDriverInstalled,
  startAppiumServerOnFreePort: mocks.startAppiumServerOnFreePort,
  stopAppiumServer: mocks.stopAppiumServer,
}));
vi.mock('../providers/emulator/boot', () => ({
  shutdownBootedEmulators: mocks.shutdownBootedEmulators,
}));
vi.mock('../providers/slots', () => ({
  APPIUM_PORT_ENV: 'APPWRIGHT_APPIUM_PORT',
  assertWorkersFitDevices: mocks.assertWorkersFitDevices,
}));

import globalSetup from '../global-setup';

const originalArgv = process.argv;

function project(name: string) {
  return {
    name,
    outputDir: `test-results/${name}`,
    use: { platform: 'android', device: { provider: 'emulator', devices: [{ udid: 'x' }] } },
  };
}

const config: any = {
  workers: 1,
  reporter: [],
  projects: [project('first'), project('second')],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertWorkersFitDevices.mockReset();
  mocks.startAppiumServerOnFreePort.mockResolvedValue({
    process: mocks.appiumProcess,
    port: 4723,
  });
  process.argv = ['node', 'playwright', 'test', '--project=first', '--project=second'];
});

afterEach(() => {
  process.argv = originalArgv;
  delete process.env.APPWRIGHT_APPIUM_PORT;
});

test('a project failing after Appium started stops it and the emulators, then rethrows', async () => {
  mocks.assertWorkersFitDevices.mockImplementation((_device, _workers, name: string) => {
    if (name === 'second') {
      throw new Error('workers do not fit devices for "second"');
    }
  });

  await expect(globalSetup(config)).rejects.toThrow('workers do not fit devices for "second"');
  expect(mocks.startAppiumServerOnFreePort).toHaveBeenCalledTimes(1);
  expect(mocks.stopAppiumServer).toHaveBeenCalledWith(mocks.appiumProcess);
  expect(mocks.shutdownBootedEmulators).toHaveBeenCalledTimes(1);
});

test('a successful setup leaves Appium running until the returned teardown', async () => {
  const teardown = await globalSetup(config);
  expect(mocks.stopAppiumServer).not.toHaveBeenCalled();
  expect(process.env.APPWRIGHT_APPIUM_PORT).toBe('4723');
  await teardown();
  expect(mocks.stopAppiumServer).toHaveBeenCalledWith(mocks.appiumProcess);
  expect(mocks.shutdownBootedEmulators).toHaveBeenCalledTimes(1);
});
