import { describe, expect, test } from 'vitest';

import { mergeCapabilities } from '../providers/slots';

describe('mergeCapabilities', () => {
  const base = { platformName: 'ios', 'appium:autoAcceptAlerts': true, 'appium:udid': 'abc' };

  test('returns the base unchanged without overrides', () => {
    expect(mergeCapabilities(base, undefined)).toBe(base);
  });

  test('prefixes bare names with appium: and lets them override appwright defaults', () => {
    expect(mergeCapabilities(base, { autoAcceptAlerts: false, xcodeOrgId: 'TEAM123456' })).toEqual({
      platformName: 'ios',
      'appium:autoAcceptAlerts': false,
      'appium:udid': 'abc',
      'appium:xcodeOrgId': 'TEAM123456',
    });
  });

  test('keeps vendor-prefixed and W3C keys as written', () => {
    const merged = mergeCapabilities(base, {
      'appium:showXcodeLog': true,
      'bstack:options': { debug: true },
      platformName: 'iOS',
    });
    expect(merged['appium:showXcodeLog']).toBe(true);
    expect(merged['bstack:options']).toEqual({ debug: true });
    expect(merged.platformName).toBe('iOS');
    expect(merged).not.toHaveProperty('appium:platformName');
  });

  test('does not mutate the base', () => {
    mergeCapabilities(base, { udid: 'other' });
    expect(base['appium:udid']).toBe('abc');
  });
});
