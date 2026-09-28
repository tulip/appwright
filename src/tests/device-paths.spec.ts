import { describe, expect, test } from 'vitest';
//@ts-ignore
import { Client as WebDriverClient } from 'webdriver';

import { Device } from '../device';

function device(isAndroid: boolean, bundleId: string | undefined = 'com.example.app'): Device {
  //@ts-ignore partial mock
  const client: WebDriverClient = { isAndroid };
  return new Device(client, bundleId, { expectTimeout: 1_000 }, 'emulator');
}

/** What BrowserStack hands back when the uploaded app has no name. */
const NO_BUNDLE_ID = '';

describe('app container paths', () => {
  test('Android paths live under @package', () => {
    const d = device(true);
    expect(d.appContainerPath('/files/x.txt')).toBe('@com.example.app/files/x.txt');
    expect(d.appDocumentsPath()).toBe('@com.example.app/files');
    expect(d.appDocumentsPath('/a/b.pdf')).toBe('@com.example.app/files/a/b.pdf');
    expect(d.appCachePath()).toBe('@com.example.app/cache');
    expect(d.appCachePath('print/out.pdf')).toBe('@com.example.app/cache/print/out.pdf');
  });

  test('iOS paths address the data container, not the read-only bundle', () => {
    const d = device(false);
    expect(d.appContainerPath('Documents/x.txt')).toBe('@com.example.app:data/Documents/x.txt');
    expect(d.appDocumentsPath()).toBe('@com.example.app:data/Documents');
    expect(d.appCachePath('out.pdf')).toBe('@com.example.app:data/Library/Caches/out.pdf');
  });

  test('publicDownloadsPath is Android only', () => {
    expect(device(true).publicDownloadsPath('/report.pdf')).toBe('/sdcard/Download/report.pdf');
    expect(() => device(false).publicDownloadsPath('report.pdf')).toThrow(
      'iOS has no public downloads directory',
    );
  });

  test('getAppBundleId throws when the provider could not determine it', () => {
    expect(device(true).getAppBundleId()).toBe('com.example.app');
    expect(() => device(true, NO_BUNDLE_ID).getAppBundleId()).toThrow('has no bundle id');
    expect(() => device(true, NO_BUNDLE_ID).appDocumentsPath()).toThrow('has no bundle id');
  });

  test('getProvider reports the project provider', () => {
    expect(device(true).getProvider()).toBe('emulator');
  });
});
