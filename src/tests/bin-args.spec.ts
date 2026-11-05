import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG_FILE, extractDeviceArgs, prepareInvocation } from '../bin/args';
import { DEVICE_ENV, WAIT_FOR_DEVICE_ENV } from '../providers/device-pool';
import { RUN_NAME_ENV } from '../run-name';

describe('prepareInvocation', () => {
  test('strips --run-name and passes it on through the environment', () => {
    const result = prepareInvocation(['test', '--run-name', 'smoke', '--project', 'ios'], {});
    expect(result.runName).toBe('smoke');
    expect(result.env).toEqual({ [RUN_NAME_ENV]: 'smoke' });
    expect(result.pwArgs).toEqual(['test', '--project', 'ios', '--config', DEFAULT_CONFIG_FILE]);
  });

  test('accepts the --run-name=<name> form and sanitizes the value', () => {
    const result = prepareInvocation(['test', '--run-name=nightly run', '--project', 'ios'], {});
    expect(result.runName).toBe('nightly-run');
    expect(result.pwArgs).not.toContain('--run-name=nightly run');
  });

  test('appends the default config only when no config flag is given', () => {
    expect(prepareInvocation(['test'], {}).pwArgs).toEqual(['test', '--config', DEFAULT_CONFIG_FILE]);
    expect(prepareInvocation(['test', '--config', 'custom.ts'], {}).pwArgs).toEqual([
      'test',
      '--config',
      'custom.ts',
    ]);
    expect(prepareInvocation(['test', '-c', 'custom.ts'], {}).pwArgs).toEqual([
      'test',
      '-c',
      'custom.ts',
    ]);
    expect(prepareInvocation(['test', '--config=custom.ts'], {}).pwArgs).toEqual([
      'test',
      '--config=custom.ts',
    ]);
  });

  test('prefers the flag over the environment', () => {
    const result = prepareInvocation(['test', '--run-name', 'flag'], { [RUN_NAME_ENV]: 'env' });
    expect(result.runName).toBe('flag');
  });

  test('falls back to APPWRIGHT_RUN_NAME from the environment', () => {
    const result = prepareInvocation(['test', '--project', 'ios'], { [RUN_NAME_ENV]: 'from-ci' });
    expect(result.runName).toBe('from-ci');
    expect(result.env).toEqual({ [RUN_NAME_ENV]: 'from-ci' });
  });

  test('generates <project>-<timestamp>-<suffix> when neither is given', () => {
    const result = prepareInvocation(['test', '--project', 'android'], {});
    expect(result.runName).toMatch(/^android-\d{8}-\d{6}-[0-9a-z]{4}$/);
    expect(result.env[RUN_NAME_ENV]).toBe(result.runName);
  });

  test('treats a blank environment value as unset', () => {
    const result = prepareInvocation(['test'], { [RUN_NAME_ENV]: '' });
    expect(result.runName).toMatch(/^run-\d{8}-\d{6}-[0-9a-z]{4}$/);
  });

  test('throws when --run-name has no value', () => {
    expect(() => prepareInvocation(['test', '--run-name'], {})).toThrow(/--run-name requires a value/);
  });
});

describe('--device and --wait-for-device', () => {
  test('are stripped and passed on through the environment', () => {
    const result = prepareInvocation(
      ['test', '--project', 'android', '--device', 'emulator-5556', '--wait-for-device', '120'],
      {},
    );
    expect(result.pwArgs).toEqual(['test', '--project', 'android', '--config', DEFAULT_CONFIG_FILE]);
    expect(result.env[DEVICE_ENV]).toBe('emulator-5556');
    expect(result.env[WAIT_FOR_DEVICE_ENV]).toBe('120');
  });

  test('accept the = form and names with spaces', () => {
    const result = prepareInvocation(['test', '--device=iPhone 17 Pro', '--wait-for-device=0'], {});
    expect(result.env[DEVICE_ENV]).toBe('iPhone 17 Pro');
    expect(result.env[WAIT_FOR_DEVICE_ENV]).toBe('0');
    expect(result.pwArgs).toEqual(['test', '--config', DEFAULT_CONFIG_FILE]);
  });

  test('work alongside --run-name in any order', () => {
    const result = prepareInvocation(
      ['test', '--device', 'X', '--run-name', 'smoke', '--project', 'ios', '--grep', '@smoke'],
      {},
    );
    expect(result.pwArgs).toEqual([
      'test',
      '--project',
      'ios',
      '--grep',
      '@smoke',
      '--config',
      DEFAULT_CONFIG_FILE,
    ]);
    expect(result.env).toEqual({ APPWRIGHT_RUN_NAME: 'smoke', [DEVICE_ENV]: 'X' });
  });

  test('leave the environment alone when absent, so APPWRIGHT_DEVICE set by the caller applies', () => {
    const result = prepareInvocation(['test'], { [DEVICE_ENV]: 'from-env' });
    expect(result.env).not.toHaveProperty(DEVICE_ENV);
    expect(result.env).not.toHaveProperty(WAIT_FOR_DEVICE_ENV);
  });

  test('the last occurrence wins', () => {
    expect(extractDeviceArgs(['--device', 'a', '--device', 'b']).device).toBe('b');
  });

  test('a missing or bad value throws', () => {
    expect(() => extractDeviceArgs(['test', '--device'])).toThrow(/requires a udid or name/);
    expect(() => extractDeviceArgs(['test', '--device', '--project', 'ios'])).toThrow(
      /requires a udid or name/,
    );
    expect(() => extractDeviceArgs(['--device', '   '])).toThrow(/requires a udid or name/);
    expect(() => extractDeviceArgs(['--wait-for-device'])).toThrow(/requires a number of seconds/);
    expect(() => extractDeviceArgs(['--wait-for-device', 'soon'])).toThrow(/non-negative number/);
    expect(() => extractDeviceArgs(['--wait-for-device=-5'])).toThrow(/non-negative number/);
  });
});
