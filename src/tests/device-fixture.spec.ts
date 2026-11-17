import fs from 'fs';
import os from 'os';
import path from 'path';

import type { TestInfo } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Device } from '../device';
import { useDevice } from '../fixture/device';
import { recordingOptions } from '../fixture/recording';
import { DeviceOrientation, DeviceProvider, Platform } from '../types';

let outputDir: string;

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appwright-device-fixture-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Fakes that append every call to `calls`, so a test can check the whole lifecycle's order. */
function setup({
  provider = 'emulator',
  platform = Platform.ANDROID,
  orientation,
}: { provider?: string; platform?: Platform; orientation?: DeviceOrientation } = {}) {
  const calls: string[] = [];
  const record =
    (name: string, result?: unknown) =>
    async (...args: unknown[]) => {
      calls.push(args.length ? `${name}(${JSON.stringify(args[0])})` : name);
      return result;
    };
  const device = {
    getPlatform: () => platform,
    activateApp: vi.fn(record('activateApp')),
    startScreenRecording: vi.fn(record('startScreenRecording')),
    stopScreenRecording: vi.fn(
      record('stopScreenRecording', Buffer.from('mp4 bytes').toString('base64')),
    ),
    restoreOrientation: vi.fn(record('restoreOrientation')),
    close: vi.fn(record('close')),
  };
  const deviceProvider = {
    sessionId: 'session-1',
    getDevice: vi.fn(async () => {
      calls.push('getDevice');
      return device as unknown as Device;
    }),
    syncTestDetails: vi.fn(async (details: { status?: string }) => {
      calls.push(details.status ? `syncTestDetails(${details.status})` : 'syncTestDetails');
    }),
  } as unknown as DeviceProvider;
  const testInfo = {
    title: 'a test',
    retry: 0,
    status: 'passed',
    expectedStatus: 'passed',
    annotations: [] as TestInfo['annotations'],
    attachments: [] as TestInfo['attachments'],
    outputPath: (name: string) => path.join(outputDir, name),
    _currentHookType: () => undefined,
    project: { use: { platform, device: { provider, orientation } } },
  } as unknown as TestInfo;
  const use = vi.fn(async () => {
    calls.push('test body');
  });
  return { calls, device, deviceProvider, testInfo, use };
}

describe('useDevice', () => {
  test('records around the test, then stops, rotates back and closes, in that order', async () => {
    const { calls, deviceProvider, testInfo, use } = setup({
      orientation: DeviceOrientation.LANDSCAPE,
    });

    await useDevice(deviceProvider, 'on', use, testInfo);

    expect(calls).toEqual([
      'getDevice',
      'activateApp',
      'syncTestDetails',
      `startScreenRecording(${JSON.stringify(recordingOptions(Platform.ANDROID))})`,
      'test body',
      'stopScreenRecording',
      'restoreOrientation("landscape")',
      'close',
      'syncTestDetails(passed)',
    ]);
    expect(testInfo.attachments).toEqual([
      { name: 'video', path: path.join(outputDir, 'video.mp4'), contentType: 'video/mp4' },
    ]);
    expect(testInfo.annotations).toEqual([
      { type: 'providerName', description: 'emulator' },
      { type: 'sessionId', description: 'session-1' },
    ]);
  });

  test('rotates back to portrait when the project sets no orientation', async () => {
    const { device, deviceProvider, testInfo, use } = setup();
    await useDevice(deviceProvider, 'on', use, testInfo);
    expect(device.restoreOrientation).toHaveBeenCalledWith(DeviceOrientation.PORTRAIT);
  });

  test('does not record when the video option is off', async () => {
    const { calls, device, deviceProvider, testInfo, use } = setup();
    await useDevice(deviceProvider, undefined, use, testInfo);
    expect(device.startScreenRecording).not.toHaveBeenCalled();
    expect(device.stopScreenRecording).not.toHaveBeenCalled();
    expect(calls.slice(-3)).toEqual([
      'restoreOrientation("portrait")',
      'close',
      'syncTestDetails(passed)',
    ]);
  });

  test('leaves recording to a cloud provider, by the project provider name', async () => {
    const { device, deviceProvider, testInfo, use } = setup({ provider: 'browserstack' });
    await useDevice(deviceProvider, 'on', use, testInfo);
    expect(device.startScreenRecording).not.toHaveBeenCalled();
    expect(testInfo.attachments).toEqual([]);
  });

  test('does not activate the app on iOS', async () => {
    const { device, deviceProvider, testInfo, use } = setup({ platform: Platform.IOS });
    await useDevice(deviceProvider, 'on', use, testInfo);
    expect(device.activateApp).not.toHaveBeenCalled();
    expect(device.startScreenRecording).toHaveBeenCalledWith(recordingOptions(Platform.IOS));
  });
});
