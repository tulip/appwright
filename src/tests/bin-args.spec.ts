import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG_FILE, prepareInvocation } from '../bin/args';
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
