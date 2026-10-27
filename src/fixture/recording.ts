import fs from 'fs';
import path from 'path';

import type { PlaywrightWorkerOptions, TestInfo, VideoMode } from '@playwright/test';

import type { Device } from '../device';
import { logger } from '../logger';
import { getProviderClass } from '../providers';
import { Platform } from '../types';

/**
 * Longest recording appwright asks for, in seconds. uiautomator2 rejects a `timeLimit` above 1800
 * (XCUITest allows 4200); a test that runs longer keeps the first 30 minutes.
 */
export const RECORDING_TIME_LIMIT_SEC = 1800;

/** Same normalisation as Playwright's own `video` fixture, including the deprecated alias. */
export function normalizeVideoMode(video: PlaywrightWorkerOptions['video'] | undefined): VideoMode {
  if (!video) {
    return 'off';
  }
  const mode = typeof video === 'string' ? video : video.mode;
  return mode === 'retry-with-video' ? 'on-first-retry' : mode;
}

/** Whether to start recording this attempt, matching Playwright's browser videos. */
export function shouldRecordVideo(mode: VideoMode, retry: number): boolean {
  return (
    mode === 'on' || mode === 'retain-on-failure' || (mode === 'on-first-retry' && retry === 1)
  );
}

/** Whether to keep the recording once the attempt has finished, matching Playwright. */
export function shouldKeepVideo(
  mode: VideoMode,
  result: Pick<TestInfo, 'status' | 'expectedStatus' | 'retry'>,
): boolean {
  const failed = result.status !== result.expectedStatus;
  return (
    mode === 'on' ||
    (mode === 'retain-on-failure' && failed) ||
    (mode === 'on-first-retry' && result.retry === 1)
  );
}

/**
 * `startRecordingScreen` options per platform.
 *
 * - Android records with `adb shell screenrecord` (H.264, plays in the html report as is). The
 *   driver restarts it every 180 s and joins the pieces with ffmpeg on the Appium host.
 * - iOS pipes WebDriverAgent's MJPEG stream through ffmpeg on the Appium host. The driver's default
 *   `mjpeg` codec does not play in browsers, so encode H.264 in yuv420p, which needs even
 *   dimensions.
 *
 * `forceRestart` skips the driver's attempt to stop an earlier recording first; every session
 * starts with none.
 */
export function recordingOptions(platform: Platform): Record<string, unknown> {
  const common = { timeLimit: RECORDING_TIME_LIMIT_SEC, forceRestart: true };
  if (platform === Platform.ANDROID) {
    return common;
  }
  return {
    ...common,
    videoType: 'libx264',
    pixelFormat: 'yuv420p',
    videoFilters: 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
  };
}

/**
 * Whether the fixture is being set up for a `beforeAll` / `afterAll` hook. Playwright gives such a
 * hook its own instance of every test-scoped fixture and tears it down when the hook ends, so a
 * `useCleanDevice()` reinstall would otherwise get a recording of its own. `beforeEach` shares the
 * test's instance, so it is not excluded.
 *
 * Playwright has no public API for this; `_currentHookType()` is internal (present in 1.58). If a
 * later version drops it, hooks are recorded again rather than tests going unrecorded.
 */
export function isInsideAllHook(testInfo: TestInfo): boolean {
  const currentHookType = (testInfo as unknown as { _currentHookType?: () => string | undefined })
    ._currentHookType;
  if (typeof currentHookType !== 'function') {
    return false;
  }
  const hookType = currentHookType.call(testInfo);
  return hookType === 'beforeAll' || hookType === 'afterAll';
}

/** Cloud providers record every session themselves; the reporter downloads those videos. */
function providerRecordsVideo(providerName: string | undefined): boolean {
  return !!providerName && !!getProviderClass(providerName).downloadVideo;
}

export type ScreenRecording = {
  /** Stops the recording and, when the video mode keeps it, attaches it to the test as `video`. */
  finish(): Promise<void>;
};

/**
 * Starts recording the device screen for one test when Playwright's `video` option asks for it.
 * Returns `undefined` when nothing is recorded: the mode is off for this attempt, the provider
 * records its own video, or the fixture belongs to a `beforeAll` / `afterAll` hook. A recording
 * that fails to start or stop is logged and the test carries on without a video.
 */
export async function startScreenRecording(
  device: Device,
  testInfo: TestInfo,
  options: {
    video: PlaywrightWorkerOptions['video'] | undefined;
    providerName: string | undefined;
  },
): Promise<ScreenRecording | undefined> {
  const mode = normalizeVideoMode(options.video);
  if (!shouldRecordVideo(mode, testInfo.retry)) {
    return undefined;
  }
  if (providerRecordsVideo(options.providerName)) {
    return undefined;
  }
  if (isInsideAllHook(testInfo)) {
    logger.log(`Not recording the screen for a beforeAll/afterAll hook in "${testInfo.title}".`);
    return undefined;
  }
  try {
    await device.startScreenRecording(recordingOptions(device.getPlatform()));
  } catch (error) {
    logger.warn(
      `Screen recording did not start; "${testInfo.title}" runs without a video. ${errorMessage(
        error,
      )}`,
    );
    return undefined;
  }

  return {
    async finish() {
      let base64: string;
      try {
        base64 = await device.stopScreenRecording();
      } catch (error) {
        logger.warn(
          `Screen recording for "${testInfo.title}" could not be stopped. ${errorMessage(error)}`,
        );
        return;
      }
      if (!shouldKeepVideo(mode, testInfo)) {
        return;
      }
      if (!base64) {
        logger.warn(`Screen recording for "${testInfo.title}" came back empty; no video attached.`);
        return;
      }
      const videoPath = testInfo.outputPath('video.mp4');
      try {
        fs.mkdirSync(path.dirname(videoPath), { recursive: true });
        fs.writeFileSync(videoPath, Buffer.from(base64, 'base64'));
      } catch (error) {
        logger.warn(`Video for "${testInfo.title}" could not be saved. ${errorMessage(error)}`);
        return;
      }
      // Pushed rather than `testInfo.attach()`, which would copy the file again; Playwright's own
      // browser videos are attached the same way.
      testInfo.attachments.push({ name: 'video', path: videoPath, contentType: 'video/mp4' });
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
