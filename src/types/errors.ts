export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class NonRetryableError extends Error {
  // Tells async-retry to not retry if this error is thrown
  bail = true;

  constructor(message: string, name?: string) {
    super(message);
    this.name = name || 'NonRetryableError';
  }
}

/**
 * An action's window was already closed when the action reached it, so the action did not run.
 * Never a closed window to the WebView's recovery (see `isNoSuchWindowError()`), whatever its
 * message quotes, so the action is not run again on another page. `cause` is the driver's error.
 */
export class ActionWindowClosedError extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message);
    this.name = 'ActionWindowClosedError';
  }
}
