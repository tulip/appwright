import { describe, expect, test } from 'vitest';

import { mergeUseOptions } from '../config';

describe('mergeUseOptions', () => {
  test('keeps top-level use options such as video', () => {
    expect(mergeUseOptions({ video: 'retain-on-failure', expectTimeout: 5_000 })).toMatchObject({
      video: 'retain-on-failure',
      expectTimeout: 5_000,
      actionTimeout: 20_000,
    });
  });

  test('falls back to the default expectTimeout', () => {
    expect(mergeUseOptions(undefined)).toEqual({ actionTimeout: 20_000, expectTimeout: 20_000 });
    expect(mergeUseOptions({ actionTimeout: 1_000 })).toEqual({
      actionTimeout: 1_000,
      expectTimeout: 20_000,
    });
  });
});
