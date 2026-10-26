import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { findIpaInfoPlist, getAppBundleId, readBuildInfo } from '../providers/appium';

function infoPlist(bundleId: string, version: string, build: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${build}</string>
</dict></plist>`;
}

describe('findIpaInfoPlist', () => {
  test("picks the main app's Info.plist, not a nested bundle's", () => {
    const entries = [
      'Payload/',
      'Payload/Main.app/Watch/W.app/Info.plist',
      'Payload/Main.app/AppClips/C.app/Info.plist',
      'Payload/Main.app/PlugIns/E.appex/Info.plist',
      'Payload/Main.app/Info.plist',
    ];
    expect(findIpaInfoPlist(entries)).toBe('Payload/Main.app/Info.plist');
    expect(findIpaInfoPlist(['Payload/Main.app/Watch/W.app/Info.plist'])).toBeUndefined();
  });
});

// plutil only exists on macOS, where iOS builds are read.
describe.runIf(process.platform === 'darwin')('readBuildInfo on iOS builds', () => {
  let dir: string;
  let app: string;
  let ipa: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appwright-build-info-'));
    app = path.join(dir, 'Payload', 'Main.app');
    const watch = path.join(app, 'Watch', 'W.app');
    fs.mkdirSync(watch, { recursive: true });
    fs.writeFileSync(path.join(app, 'Info.plist'), infoPlist('com.example.app', '1.0', '7'));
    fs.writeFileSync(path.join(watch, 'Info.plist'), infoPlist('com.example.watch', '9.9', '1'));
    // The nested bundle first in the archive, where a glob would find it before the main one.
    ipa = path.join(dir, 'Main.ipa');
    execFileSync('zip', ['-q', ipa, 'Payload/Main.app/Watch/W.app/Info.plist'], { cwd: dir });
    execFileSync('zip', ['-q', ipa, 'Payload/Main.app/Info.plist'], { cwd: dir });
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('reads an .app folder', async () => {
    expect(await readBuildInfo(app)).toEqual({
      bundleId: 'com.example.app',
      version: '1.0',
      buildNumber: '7',
      path: app,
    });
  });

  test("reads the main app's Info.plist out of an .ipa with a nested Watch app", async () => {
    expect(await readBuildInfo(ipa)).toEqual({
      bundleId: 'com.example.app',
      version: '1.0',
      buildNumber: '7',
      path: ipa,
    });
    expect(await getAppBundleId(ipa)).toBe('com.example.app');
  });
});
