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
