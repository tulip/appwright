import { FullProject, PlaywrightWorkerOptions, TestInfo } from '@playwright/test';

import { Device } from '../device';
import { AppwrightConfig, DeviceOrientation, DeviceProvider, Platform } from '../types';
import { finishRecordingAndClose, startScreenRecording } from './recording';

/**
 * The `device` fixture: opens the session, runs the test with it (`use`), and tears it down. Kept
 * out of `test.extend` so a unit test can drive the whole lifecycle with fakes.
 */
export async function useDevice(
  deviceProvider: DeviceProvider,
  video: PlaywrightWorkerOptions['video'] | undefined,
  use: (device: Device) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  const device = await deviceProvider.getDevice();
  const project = testInfo.project as FullProject<AppwrightConfig>;
  const platform = project.use.platform;

  // For Android, activate the app before running the test to ensure it's in the foreground.
  if (platform === Platform.ANDROID) {
    try {
      await device.activateApp();
    } catch (error) {
      // Silently ignore activation errors
      console.log('[Fixture] Failed to activate app:', error);
    }
  }

  const deviceProviderName = project.use.device?.provider;
  testInfo.annotations.push({
    type: 'providerName',
    description: deviceProviderName,
  });
  testInfo.annotations.push({
    type: 'sessionId',
    description: deviceProvider.sessionId,
  });
  await deviceProvider.syncTestDetails?.({ name: testInfo.title });
  // Honors Playwright's `video` option for local devices and emulators; cloud providers record
  // every session themselves and the reporter downloads those videos.
  const recording = await startScreenRecording(device, testInfo, {
    video,
    providerName: deviceProviderName,
  });
  await use(device);
  // Stop recording before the rotation back, so the video ends where the test did. A rotation
  // outlives the session: put back what the project configures for the next test.
  await finishRecordingAndClose(device, recording, () =>
    device.restoreOrientation(project.use.device?.orientation ?? DeviceOrientation.PORTRAIT),
  );
  await deviceProvider.syncTestDetails?.({
    name: testInfo.title,
    status: testInfo.status,
    reason: testInfo.error?.message,
  });
}
