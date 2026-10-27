import fs from 'fs';
import os from 'os';
import path from 'path';

import type { TestInfo } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Device } from '../device';
import {
  isInsideAllHook,
  normalizeVideoMode,
  recordingOptions,
  RECORDING_TIME_LIMIT_SEC,
  shouldKeepVideo,
  shouldRecordVideo,
  startScreenRecording,
} from '../fixture/recording';
import { Platform } from '../types';

describe('normalizeVideoMode', () => {
  test('treats an unset option as off', () => {
    expect(normalizeVideoMode(undefined)).toBe('off');
  });

  test('reads the mode from a string or an object', () => {
    expect(normalizeVideoMode('on')).toBe('on');
    expect(normalizeVideoMode({ mode: 'retain-on-failure', size: { width: 1, height: 1 } })).toBe(
      'retain-on-failure',
    );
  });

  test('maps the deprecated retry-with-video alias', () => {
    expect(normalizeVideoMode('retry-with-video')).toBe('on-first-retry');
  });
});

describe('shouldRecordVideo', () => {
  test.each([
    ['off', 0, false],
    ['on', 0, true],
    ['on', 2, true],
    ['retain-on-failure', 0, true],
    ['on-first-retry', 0, false],
    ['on-first-retry', 1, true],
    ['on-first-retry', 2, false],
  ] as const)('%s on retry %d -> %s', (mode, retry, expected) => {
    expect(shouldRecordVideo(mode, retry)).toBe(expected);
  });
});

describe('shouldKeepVideo', () => {
  const passed = { status: 'passed', expectedStatus: 'passed', retry: 0 } as const;
  const failed = { status: 'failed', expectedStatus: 'passed', retry: 0 } as const;
  const timedOut = { status: 'timedOut', expectedStatus: 'passed', retry: 0 } as const;
  const failedAsExpected = { status: 'failed', expectedStatus: 'failed', retry: 0 } as const;

  test('on keeps every video', () => {
    expect(shouldKeepVideo('on', passed)).toBe(true);
    expect(shouldKeepVideo('on', failed)).toBe(true);
  });

  test('retain-on-failure keeps only unexpected results', () => {
    expect(shouldKeepVideo('retain-on-failure', passed)).toBe(false);
    expect(shouldKeepVideo('retain-on-failure', failed)).toBe(true);
    expect(shouldKeepVideo('retain-on-failure', timedOut)).toBe(true);
    expect(shouldKeepVideo('retain-on-failure', failedAsExpected)).toBe(false);
  });

  test('on-first-retry keeps the first retry only', () => {
    expect(shouldKeepVideo('on-first-retry', { ...passed, retry: 1 })).toBe(true);
    expect(shouldKeepVideo('on-first-retry', { ...failed, retry: 0 })).toBe(false);
  });
});

describe('recordingOptions', () => {
  test('Android uses the screenrecord defaults with the longest time limit', () => {
    expect(recordingOptions(Platform.ANDROID)).toEqual({
      timeLimit: RECORDING_TIME_LIMIT_SEC,
      forceRestart: true,
    });
  });

  test('iOS encodes browser-playable H.264 with even dimensions', () => {
    expect(recordingOptions(Platform.IOS)).toMatchObject({
      timeLimit: RECORDING_TIME_LIMIT_SEC,
      videoType: 'libx264',
      pixelFormat: 'yuv420p',
      videoFilters: 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    });
  });
});

describe('isInsideAllHook', () => {
  const withHook = (hookType: string | undefined) =>
    ({ _currentHookType: () => hookType } as unknown as TestInfo);

  test('is true for beforeAll and afterAll', () => {
    expect(isInsideAllHook(withHook('beforeAll'))).toBe(true);
    expect(isInsideAllHook(withHook('afterAll'))).toBe(true);
  });

  test('is false for beforeEach and the test body', () => {
    expect(isInsideAllHook(withHook('beforeEach'))).toBe(false);
    expect(isInsideAllHook(withHook(undefined))).toBe(false);
  });

  test('is false when Playwright no longer has the internal method', () => {
    expect(isInsideAllHook({} as TestInfo)).toBe(false);
  });
});

describe('startScreenRecording', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appwright-recording-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function fakeDevice(overrides: Partial<Record<keyof Device, unknown>> = {}) {
    return {
      getPlatform: vi.fn().mockReturnValue(Platform.ANDROID),
      startScreenRecording: vi.fn().mockResolvedValue(undefined),
      stopScreenRecording: vi.fn().mockResolvedValue(Buffer.from('mp4 bytes').toString('base64')),
      ...overrides,
    };
  }

  function fakeTestInfo(overrides: Record<string, unknown> = {}) {
    return {
      title: 'a test',
      retry: 0,
      status: 'passed',
      expectedStatus: 'passed',
      attachments: [] as TestInfo['attachments'],
      outputPath: (name: string) => path.join(outputDir, name),
      _currentHookType: () => undefined,
      ...overrides,
    };
  }

  async function run(
    device: ReturnType<typeof fakeDevice>,
    testInfo: ReturnType<typeof fakeTestInfo>,
    video: Parameters<typeof startScreenRecording>[2]['video'],
    providerName = 'emulator',
  ) {
    return startScreenRecording(device as unknown as Device, testInfo as unknown as TestInfo, {
      video,
      providerName,
    });
  }

  test('records and attaches the video as video.mp4 when the mode is on', async () => {
    const device = fakeDevice();
    const testInfo = fakeTestInfo();
    const recording = await run(device, testInfo, 'on');
    expect(device.startScreenRecording).toHaveBeenCalledWith(recordingOptions(Platform.ANDROID));

    await recording!.finish();
    const videoPath = path.join(outputDir, 'video.mp4');
    expect(testInfo.attachments).toEqual([
      { name: 'video', path: videoPath, contentType: 'video/mp4' },
    ]);
    expect(fs.readFileSync(videoPath, 'utf8')).toBe('mp4 bytes');
  });

  test('passes the iOS options on iOS', async () => {
    const device = fakeDevice({ getPlatform: vi.fn().mockReturnValue(Platform.IOS) });
    await run(device, fakeTestInfo(), 'on');
    expect(device.startScreenRecording).toHaveBeenCalledWith(recordingOptions(Platform.IOS));
  });

  test('stops but discards a passing test under retain-on-failure', async () => {
    const device = fakeDevice();
    const testInfo = fakeTestInfo();
    const recording = await run(device, testInfo, 'retain-on-failure');
    await recording!.finish();
    expect(device.stopScreenRecording).toHaveBeenCalled();
    expect(testInfo.attachments).toEqual([]);
    expect(fs.existsSync(path.join(outputDir, 'video.mp4'))).toBe(false);
  });

  test('keeps a failing test under retain-on-failure', async () => {
    const testInfo = fakeTestInfo();
    const recording = await run(fakeDevice(), testInfo, 'retain-on-failure');
    testInfo.status = 'failed';
    await recording!.finish();
    expect(testInfo.attachments).toHaveLength(1);
  });

  test('does nothing when the mode is off', async () => {
    const device = fakeDevice();
    expect(await run(device, fakeTestInfo(), undefined)).toBeUndefined();
    expect(device.startScreenRecording).not.toHaveBeenCalled();
  });

  test('leaves cloud providers to their own recording', async () => {
    const device = fakeDevice();
    expect(await run(device, fakeTestInfo(), 'on', 'browserstack')).toBeUndefined();
    expect(device.startScreenRecording).not.toHaveBeenCalled();
  });

  test('does not record a beforeAll hook', async () => {
    const device = fakeDevice();
    const testInfo = fakeTestInfo({ _currentHookType: () => 'beforeAll' });
    expect(await run(device, testInfo, 'on')).toBeUndefined();
    expect(device.startScreenRecording).not.toHaveBeenCalled();
  });

  test('carries on without a video when recording cannot start', async () => {
    const device = fakeDevice({
      startScreenRecording: vi.fn().mockRejectedValue(new Error('ffmpeg not found')),
    });
    expect(await run(device, fakeTestInfo(), 'on')).toBeUndefined();
  });

  test('attaches nothing when stopping fails or returns nothing', async () => {
    const failing = fakeTestInfo();
    const failingDevice = fakeDevice({
      stopScreenRecording: vi.fn().mockRejectedValue(new Error('session gone')),
    });
    await (await run(failingDevice, failing, 'on'))!.finish();
    expect(failing.attachments).toEqual([]);

    const empty = fakeTestInfo();
    await (await run(
      fakeDevice({ stopScreenRecording: vi.fn().mockResolvedValue('') }),
      empty,
      'on',
    ))!.finish();
    expect(empty.attachments).toEqual([]);
  });
});
