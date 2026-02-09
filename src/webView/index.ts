import retry from 'async-retry';

import { Device } from '../device';
import {
  AppwrightLocator,
  Platform,
} from '../types';
import { NonRetryableError } from '../types/errors';
import {
  boxedStep,
  isNoSuchWindowError,
} from '../utils';

/**
 * WebView class for interacting with WebView content in hybrid mobile apps.
 * Automatically handles context switching to WEBVIEW context.
 *
 * **Usage:**
 * ```js
 * test('WebView test', async ({ webView }) => {
 *   await webView.getByTestId('username').fill('admin');
 *   await webView.getByTestId('password').fill('password123');
 *   await webView.getByText('Login').tap();
 * });
 * ```
 */
export class WebView {
  constructor(private device: Device) {}

  /**
   * Ensures we're in WEBVIEW context before any operation.
   * If not in a WEBVIEW context, discovers and switches to the first available one.
   */
  private async ensureWebViewContext(): Promise<void> {
    const currentContext = await this.device.getCurrentContext();
    console.log('[WebView] Current context:', currentContext);

    if (!currentContext.includes('WEBVIEW')) {
      await this.switchToWebviewContext();
      // await this.waitForPageReady();
    }
  }

  /**
   * Helper method to recover from window closure by resetting WebView context.
   * Uses async-retry to handle transient failures.
   */
  private async recoverFromWindowClosure<T>(operation: () => Promise<T>): Promise<T> {
    return await retry(
      async () => {
        try {
          return await operation();
        } catch (error) {
          if (!isNoSuchWindowError(error)) {
            // We don't want to retry all errors. Only those related to window closure
            throw new NonRetryableError(
              error instanceof Error ? error.message : String(error),
              error instanceof Error ? error.name : undefined,
            );
          }

          console.log('[WebView] Window closed error detected. Reconnecting...');

          try {
            const currentWindowHandle = await this.device.getCurrentWindowHandle();
            console.log('[WebView] Current window handle:', currentWindowHandle);
          } catch {
            console.log('[WebView] Could not get current window handle');
          }
          try {
            const activeWindowHandles = await this.device.getWindowHandles();
            console.log('[WebView] Active window handles:', activeWindowHandles);
          } catch (e) {
            console.log('[WebView] Could not get active window handles');
          }

          await this.device.switchContext('NATIVE_APP');
          console.log('[WebView] Switched to NATIVE_APP');

          await this.ensureWebViewContext();
          console.log('[WebView] Re-established WebView context');

          throw error;
        }
      },
      {
        retries: 3,
        minTimeout: 2000,
        maxTimeout: 10_000,
        factor: 1,
        onRetry: (error: Error, attempt: number) => {
          console.log(`[WebView] Window recovery retry attempt ${attempt}/3:`, error.message);
        },
      },
    );
  }

  locator({
    selector,
    findStrategy,
    textToMatch,
  }: {
    selector: string;
    findStrategy: string;
    textToMatch?: string | RegExp;
  }): AppwrightLocator {
    const originalLocator = this.device.createLocator({
      selector,
      findStrategy,
      textToMatch,
    });
    // Wrap all locator methods to ensure webview context
    return this.wrapWithContextSwitch(originalLocator);
  }

  /**
   * Wraps a locator to automatically switch to webview context before any action
   */
  private wrapWithContextSwitch(locator: AppwrightLocator): AppwrightLocator {
    const self = this;
    return new Proxy(locator, {
      get(target, prop) {
        const original = target[prop as keyof AppwrightLocator];

        // Wrap all async methods (actions that interact with elements)
        if (typeof original === 'function' && prop !== 'constructor') {
          return async function (...args: any[]) {
            await self.ensureWebViewContext();

            // Use the helper method with async-retry for recovery
            return await self.recoverFromWindowClosure(async () => {
              return await (original as Function).apply(target, args);
            });
          };
        }

        return original;
      },
    });
  }

  /**
   * Locate an element by data-testid attribute.
   * This is the recommended way to locate elements in WebViews.
   *
   * **Usage:**
   * ```js
   * // Fill an input field
   * await webView.getByTestId('login-badgeid').fill('0000');
   *
   * // Tap a button
   * await webView.getByTestId('submit-button').tap();
   *
   * // Check visibility
   * await expect(webView.getByTestId('success-message')).toBeVisible();
   * ```
   *
   * @param testId - The value of the data-testid attribute
   * @returns AppwrightLocator
   */
  getByTestId(testId: string): AppwrightLocator {
    return this.locator({
      selector: `[data-testid="${testId}"]`,
      findStrategy: 'css selector',
    });
  }

  /**
   * Locate an element by its visible text content.
   *
   * **Usage:**
   * ```js
   * // Tap a button with exact text
   * await webView.getByText('Submit', { exact: true }).tap();
   *
   * // Partial text match (default)
   * await webView.getByText('Welcome').tap();
   *
   * // Using RegExp
   * await expect(webView.getByText(/User \d+/)).toBeVisible();
   * ```
   *
   * @param text - String or RegExp to match against element text
   * @param options - Options for matching
   * @returns AppwrightLocator
   */
  getByText(text: string | RegExp, { exact = false }: { exact?: boolean } = {}): AppwrightLocator {
    if (text instanceof RegExp) {
      return this.locator({
        selector: `//*[contains(., "${text.source}")]`,
        findStrategy: 'xpath',
        textToMatch: text,
      });
    }

    if (exact) {
      return this.locator({
        selector: `//*[.="${text}"]`,
        findStrategy: 'xpath',
      });
    }

    return this.locator({
      selector: `//*[contains(., "${text}")]`,
      findStrategy: 'xpath',
    });
  }

  /**
   * Locate an element by CSS selector.
   * Use this for complex selectors or when data-testid is not available.
   *
   * **Usage:**
   * ```js
   * // By class
   * await webView.css('.submit-button').tap();
   *
   * // By ID
   * await webView.css('#username').fill('admin');
   *
   * // Complex selector
   * await webView.css('form > button[type="submit"]').tap();
   * ```
   *
   * @param selector - CSS selector string
   * @returns AppwrightLocator
   */
  css(selector: string): AppwrightLocator {
    return this.locator({
      selector,
      findStrategy: 'css selector',
    });
  }

  /**
   * Locate an element by XPath expression.
   * Use for complex queries that CSS selectors cannot express.
   *
   * **Usage:**
   * ```js
   * // By attribute
   * await webView.getByXpath('//button[@type="submit"]').tap();
   *
   * // Complex hierarchy
   * await webView.getByXpath('//div[@class="form"]//input[@name="email"]').fill('test@example.com');
   * ```
   *
   * @param xpath - XPath expression
   * @returns AppwrightLocator
   */
  getByXpath(xpath: string): AppwrightLocator {
    return this.locator({
      selector: xpath,
      findStrategy: 'xpath',
    });
  }

  /**
   * Locate an input element by its placeholder text.
   *
   * **Usage:**
   * ```js
   * await webView.getByPlaceholder('Enter your email').fill('test@example.com');
   * await webView.getByPlaceholder('Search').fill('query');
   * ```
   *
   * @param text - Placeholder text to match
   * @returns AppwrightLocator
   */
  getByPlaceholder(text: string): AppwrightLocator {
    return this.locator({
      selector: `[placeholder="${text}"]`,
      findStrategy: 'css selector',
    });
  }

  /**
   * Execute JavaScript code in the WebView context.
   * Use this to interact with the page in ways not supported by standard locators.
   *
   * **Usage:**
   * ```js
   * // Get page title
   * const title = await webView.evaluate(() => document.title);
   *
   * // Scroll to bottom
   * await webView.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
   *
   * // Get computed style
   * const color = await webView.evaluate(() => {
   *   const el = document.querySelector('.header');
   *   return window.getComputedStyle(el).color;
   * });
   *
   * // Set local storage
   * await webView.evaluate(() => {
   *   localStorage.setItem('token', 'abc123');
   * });
   * ```
   *
   * @param script - JavaScript code to execute (string or function)
   * @returns Result of the script execution
   */
  @boxedStep
  async evaluate<T = any>(script: string | Function): Promise<T> {
    await this.ensureWebViewContext();
    return await this.device.evaluate<T>(script);
  }

  private async switchToWebviewContext(): Promise<void> {
    /**
     * On Android, the chromedriver (which Appium and UiAutomator2 uses under the hood) scans the entire device's debug ports.
     * It might see webviews from the system browser, background apps, or even the some widgets.
     * We are using filterByCurrentApp to only list webviews for the current app.
     *
     * This is not an issue on iOS as XCUITest creates a session specifically for the app running only lists webviews for the current app by default.
     *
     * If issues are found in the future, we can considering filtering contexts for iOS as well. Webviews on iOS are typically named like WEBVIEW_<PID>
     */
    const filterByCurrentApp = this.device.getPlatform() == Platform.ANDROID;
    const currentBundleId = filterByCurrentApp ? await this.device.getCurrentBundleId() : undefined;

    await retry(
      async () => {
        const appiumContexts = await this.device.contexts();

        const contexts = appiumContexts.map((context) => {
          if (typeof context === 'string') {
            return context;
          } else {
            return context.title;
          }
        });

        const filteredContexts = filterByCurrentApp
          ? contexts.filter((ctx) => {
              if (filterByCurrentApp && currentBundleId && ctx?.includes('WEBVIEW')) {
                return ctx.includes(currentBundleId);
              }
              return true;
            })
          : contexts;

        console.log('[WebView] Available contexts from Appium:', filteredContexts);

        const webviewContext = filteredContexts.find((ctx) => ctx?.includes('WEBVIEW'));

        if (!webviewContext) {
          throw new Error('No WebView context found. Make sure your app has a WebView loaded.');
        }

        console.log('[WebView] Switching to context:', webviewContext);
        await this.device.switchContext(webviewContext);
      },
      {
        retries: 5,
        minTimeout: 2000,
        maxTimeout: 10_000,
        onRetry: (_error: Error, attempt: number) => {
          console.log(`[WebView] Webview context not found. Retry attempt ${attempt}.`);
        },
      },
    );
  }

  private async waitForPageReady(timeout = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        // Wrap with recovery logic - it handles window closure automatically
        const state = await this.recoverFromWindowClosure(async () => {
          return await this.device.evaluate<string>('return document.readyState');
        });

        if (state === 'complete' || state === 'interactive') {
          console.log('[WebView] Page ready, state:', state);
          return;
        }
      } catch (e) {
        // Page not ready yet (non-window errors), continue waiting
        console.log('[WebView] Page not ready yet, will retry...');
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.log('[WebView] Page ready check timed out, proceeding anyway');
  }
}
