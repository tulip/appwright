import { constants } from 'buffer';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { TestInfo } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { Device } from '../device';
import type * as RecordingModule from '../fixture/recording';
import {
  ANDROID_RECORDING_BIT_RATE,
  finishRecordingAndClose,
  isInsideAllHook,
  normalizeVideoMode,
  recordingOptions,
  RECORDING_TIME_LIMIT_SEC,
  shouldKeepVideo,
  shouldRecordVideo,
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
  test('Android caps the bit rate so the longest recording fits one base64 string', () => {
    expect(recordingOptions(Platform.ANDROID)).toEqual({
      timeLimit: 900,
      forceRestart: true,
      bitRate: 1_500_000,
    });
    // The encoder overshoots its target (1.5 Mbps measured 2.35 Mbps while scrolling), so leave
    // room for 1.6x and still fit a full-length recording in one base64 string.
    const worstCaseBytes = ((ANDROID_RECORDING_BIT_RATE * 1.6) / 8) * RECORDING_TIME_LIMIT_SEC;
    expect(Math.ceil((worstCaseBytes * 4) / 3)).toBeLessThan(constants.MAX_STRING_LENGTH * 0.8);
  });

  test('iOS encodes browser-playable H.264 with even dimensions', () => {
    expect(recordingOptions(Platform.IOS)).toEqual({
      timeLimit: 900,
      forceRestart: true,
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
  // Fresh module per test: a failed start is remembered for the rest of the worker.
  let recording: typeof RecordingModule;

  beforeEach(async () => {
    vi.resetModules();
    recording = await vi.importActual<typeof RecordingModule>('../fixture/recording');
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
    video: Parameters<typeof recording.startScreenRecording>[2]['video'],
    providerName = 'emulator',
  ) {
    return recording.startScreenRecording(
      device as unknown as Device,
      testInfo as unknown as TestInfo,
      {
        video,
        providerName,
      },
    );
  }

  test('records and attaches the video as video.mp4 when the mode is on', async () => {
    const device = fakeDevice();
    const testInfo = fakeTestInfo();
    const started = await run(device, testInfo, 'on');
    expect(device.startScreenRecording).toHaveBeenCalledWith(recordingOptions(Platform.ANDROID));

    await started!.finish();
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
    const started = await run(device, testInfo, 'retain-on-failure');
    await started!.finish();
    expect(device.stopScreenRecording).toHaveBeenCalledTimes(1);
    expect(testInfo.attachments).toEqual([]);
    expect(fs.existsSync(path.join(outputDir, 'video.mp4'))).toBe(false);
  });

  test('keeps a failing test under retain-on-failure', async () => {
    const testInfo = fakeTestInfo();
    const started = await run(fakeDevice(), testInfo, 'retain-on-failure');
    testInfo.status = 'failed';
    await started!.finish();
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
    // The hook's test info belongs to a neighbouring test, so the log must not name it.
    const logged = vi.mocked(console.log).mock.calls.map((args) => String(args[1]));
    expect(logged).toEqual([
      'Not recording the device session of a beforeAll/afterAll hook; only tests are.',
    ]);
  });

  test('on-first-retry records the first retry only, through the test info', async () => {
    const firstAttempt = fakeDevice();
    expect(await run(firstAttempt, fakeTestInfo({ retry: 0 }), 'on-first-retry')).toBeUndefined();
    expect(firstAttempt.startScreenRecording).not.toHaveBeenCalled();

    const firstRetry = fakeDevice();
    const testInfo = fakeTestInfo({ retry: 1 });
    await (await run(firstRetry, testInfo, 'on-first-retry'))!.finish();
    expect(firstRetry.startScreenRecording).toHaveBeenCalledTimes(1);
    expect(testInfo.attachments).toHaveLength(1);
  });

  test('carries on without a video when recording cannot start', async () => {
    const device = fakeDevice({
      startScreenRecording: vi.fn().mockRejectedValue(new Error('ffmpeg not found')),
    });
    expect(await run(device, fakeTestInfo(), 'on')).toBeUndefined();
  });

  test('warns once and stops trying after a start failure in the worker', async () => {
    const warn = vi.mocked(console.log);
    const failing = fakeDevice({
      startScreenRecording: vi.fn().mockRejectedValue(new Error('ffmpeg not found')),
    });
    await run(failing, fakeTestInfo(), 'on');
    const later = fakeDevice();
    expect(await run(later, fakeTestInfo({ title: 'later' }), 'on')).toBeUndefined();

    expect(later.startScreenRecording).not.toHaveBeenCalled();
    const warnings = warn.mock.calls.filter((args) => String(args[1]).includes('did not start'));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]![1])).toContain('ffmpeg not found');
  });

  test('attaches nothing when the output folder cannot be created', async () => {
    const testInfo = fakeTestInfo({
      outputPath: () => {
        throw new Error('EACCES');
      },
    });
    await expect((await run(fakeDevice(), testInfo, 'on'))!.finish()).resolves.toBeUndefined();
    expect(testInfo.attachments).toEqual([]);
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

describe('finishRecordingAndClose', () => {
  const fakeDevice = (calls: string[]) =>
    ({ close: vi.fn(async () => void calls.push('close')) } as unknown as Device);

  test('stops the recording before the session closes', async () => {
    const calls: string[] = [];
    await finishRecordingAndClose(fakeDevice(calls), {
      finish: async () => void calls.push('finish'),
    });
    expect(calls).toEqual(['finish', 'close']);
  });

  test('closes the session even when finishing throws', async () => {
    const calls: string[] = [];
    const finishing = finishRecordingAndClose(fakeDevice(calls), {
      finish: () => Promise.reject(new Error('disk full')),
    });
    await expect(finishing).rejects.toThrow('disk full');
    expect(calls).toEqual(['close']);
  });

  test('closes the session when nothing was recorded', async () => {
    const calls: string[] = [];
    await finishRecordingAndClose(fakeDevice(calls), undefined);
    expect(calls).toEqual(['close']);
  });
});

describe('Device screen recording', () => {
  test('passes the options to Appium and returns its base64 video', async () => {
    const client = {
      startRecordingScreen: vi.fn().mockResolvedValue(undefined),
      stopRecordingScreen: vi.fn().mockResolvedValue('dmlkZW8='),
    };
    //@ts-ignore partial client
    const device = new Device(client, 'com.example.app', { expectTimeout: 1_000 }, 'emulator');
    const options = recordingOptions(Platform.ANDROID);

    await device.startScreenRecording(options);
    expect(client.startRecordingScreen).toHaveBeenCalledWith(options);
    expect(await device.stopScreenRecording()).toBe('dmlkZW8=');
    expect(client.stopRecordingScreen).toHaveBeenCalledWith();
  });
});
