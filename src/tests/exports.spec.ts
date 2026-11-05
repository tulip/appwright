import type * as Playwright from '@playwright/test';
import { describe, expectTypeOf, test } from 'vitest';

// Type-only: the package entry resolves its global setup off the installed build at load time,
// so it cannot be imported from source. `tsc --build`, which compiles the tests, checks these.
import type { APIRequest, APIRequestContext, APIResponse, TestInfo } from '../index';

describe('package exports', () => {
  test('re-export the Playwright types a suite reaching Playwright only through appwright needs', () => {
    expectTypeOf<APIRequest>().toEqualTypeOf<Playwright.APIRequest>();
    expectTypeOf<APIRequestContext>().toEqualTypeOf<Playwright.APIRequestContext>();
    expectTypeOf<APIResponse>().toEqualTypeOf<Playwright.APIResponse>();
    expectTypeOf<TestInfo>().toEqualTypeOf<Playwright.TestInfo>();
  });
});
