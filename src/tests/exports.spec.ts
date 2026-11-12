import type * as Playwright from '@playwright/test';
import { describe, expectTypeOf, test } from 'vitest';

// Type-only: the package entry resolves its global setup off the installed build at load time,
// so it cannot be imported from source. `tsc --build`, which compiles the tests, checks these.
import type {
  ActionWindowClosedError,
  APIRequest,
  APIRequestContext,
  APIResponse,
  TestInfo,
  TimeoutError,
} from '../index';
import type * as Errors from '../types/errors';

describe('package exports', () => {
  test('re-export the Playwright types a suite reaching Playwright only through appwright needs', () => {
    expectTypeOf<APIRequest>().toEqualTypeOf<Playwright.APIRequest>();
    expectTypeOf<APIRequestContext>().toEqualTypeOf<Playwright.APIRequestContext>();
    expectTypeOf<APIResponse>().toEqualTypeOf<Playwright.APIResponse>();
    expectTypeOf<TestInfo>().toEqualTypeOf<Playwright.TestInfo>();
  });

  test('export the error classes a suite checks with instanceof', () => {
    expectTypeOf<ActionWindowClosedError>().toEqualTypeOf<Errors.ActionWindowClosedError>();
    expectTypeOf<TimeoutError>().toEqualTypeOf<Errors.TimeoutError>();
  });
});
