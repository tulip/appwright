import retry from 'async-retry';

import { Device } from '../device';
import { devToolsPageId } from '../device/web-pages';
import { CHAIN_METHODS, Locator } from '../locator';
import {
  LocatorQuery,
  webLabelQuery,
  webRoleQuery,
  webTestIdQuery,
  webTextQuery,
} from '../locator/queries';
import {
  AppwrightLocator,
  AriaRole,
  AttachOptions,
  LabelOptions,
  NATIVE_CONTEXT,
  Platform,
  RoleOptions,
  TextOptions,
  WebPage,
} from '../types';
import {
  boxedStep,
  contextName,
  delay,
  displayUrl,
  errorMessage,
  escapeQuotes,
  isInvalidSessionError,
  isNoSuchWindowError,
  urlMatches,
} from '../utils';

/**
 * Appium names a browser's context after its DevTools socket, not its package, and every Chrome
 * channel serves `chrome_devtools_remote`: with a Custom Tab in front, the foreground package is
 * `com.android.chrome` and its context `WEBVIEW_chrome`. Only the packages Appium itself treats
 * as Chrome are listed.
 *
 * Discovery never binds a browser: a browser in front is usually a hand-off the app takes back,
 * and a context bound mid-hand-off would outlive it. A browser is bound only by
 * `attach({ context })`, and left again by the first `webView` call made once it is no longer in
 * front. If Appium ever renames these contexts, a bound browser is no longer recognised as one
 * and stays bound until the next `attach()`.
 */
const ANDROID_BROWSER_CONTEXTS: Record<string, string> = {
  'com.android.chrome': 'WEBVIEW_chrome',
  'com.chrome.beta': 'WEBVIEW_chrome',
  'com.chrome.dev': 'WEBVIEW_chrome',
  'com.chrome.canary': 'WEBVIEW_chrome',
};

/**
 * The session itself is gone: no amount of re-attaching can help. Matched against the error
 * text, the only signal the drivers give; if the wording changes, `attach()` on a dead session
 * retries until its timeout instead, and the timeout error still carries the last error.
 */
const FATAL_SESSION_ERRORS = [
  'invalid session id',
  'Session does not exist',
  'A session is either terminated or not started',
  'ECONNREFUSED',
];

const ATTACH_TIMEOUT_MS = 60_000;
const ATTACH_POLL_INTERVAL_MS = 1_000;

/** How long the WEBVIEW contexts have to stay unchanged for `settle` to count them as settled. */
const CONTEXTS_SETTLE_WINDOW_MS = 5_000;
const CONTEXTS_SETTLE_SAMPLE_MS = 1_000;

/**
 * How long discovery keeps retrying while a browser is in front before it fails with the hint to
 * `attach({ context })`: long enough for a closing Custom Tab to hand the front back to the app.
 */
const BROWSER_IN_FRONT_GRACE_MS = 5_000;

/**
 * What `attach()` bound, for `webView` calls to bind again after a step left the WebView (any
 * native `device` call switches to NATIVE_APP), after a renderer drop and after a closed window.
 * `window` is recorded on Android only, where one context spans every page of a WebView or
 * browser, and only when `page` or `pageUrl` chose it: a window `attach()` merely landed on is
 * not pinned, so a WebView the app rebuilt under a new window is still found.
 */
type AttachedPage = { context: string; window?: string };

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
  /** Set by `attach()`, cleared once discovery binds another context. */
  private attached?: AttachedPage;

  constructor(private device: Device) {}

  /**
   * Ensures we're in WEBVIEW context before any operation.
   * If not in a WEBVIEW context, binds what `attach()` bound while it lasts, else discovers and
   * switches to the first available one. A bound browser that is no longer in front is left the
   * same way (see `ANDROID_BROWSER_CONTEXTS`).
   */
  private async ensureWebViewContext(): Promise<void> {
    const currentContext = await this.device.getCurrentContext();
    console.log('[WebView] Current context:', currentContext);

    if (currentContext.includes('WEBVIEW')) {
      if (!(await this.browserPageIsBehind(currentContext))) {
        return;
      }
      // Telling whether the browser is still in front means leaving it for NATIVE_APP, so this
      // binds it again (and the window `attach()` chose) when it is.
      const bound =
        this.attached?.context === currentContext ? this.attached : { context: currentContext };
      const left = await this.switchToAttached(bound);
      if (left == null) {
        return;
      }
      console.log(`[WebView] Leaving ${currentContext}: ${left}.`);
    } else if (this.attached != null) {
      const gone = await this.switchToAttached(this.attached);
      if (gone == null) {
        return;
      }
      console.log(
        `[WebView] Not returning to ${this.attached.context}, which attach() bound: ${gone}. ` +
          'Discovering a WebView instead.',
      );
    }
    await this.switchToWebviewContext();
  }

  /**
   * Whether `context` is a browser's and its page is not showing, so the browser may have left
   * the front. Read from inside the page, which costs one script per `webView` call while a
   * browser is bound; the foreground lookup that settles it has to leave the page. A page that
   * cannot answer counts as not showing.
   */
  private async browserPageIsBehind(context: string): Promise<boolean> {
    if (
      this.device.getPlatform() != Platform.ANDROID ||
      !Object.values(ANDROID_BROWSER_CONTEXTS).includes(context)
    ) {
      return false;
    }
    try {
      return (await this.device.runScript<string>('return document.visibilityState')) !== 'visible';
    } catch {
      return true;
    }
  }

  /**
   * Why `context` is no longer the one to drive because its app or browser has left the front —
   * the app took a hand-off back, or another app came up — or `undefined` while it is still in
   * front. Android only, matching names as discovery does: a browser's context through
   * `ANDROID_BROWSER_CONTEXTS`, an app's by its package. XCUITest lists the app's own WebViews
   * only, so iOS never asks. Reading the foreground package switches to NATIVE_APP.
   */
  private async leftFront(context: string): Promise<string | undefined> {
    if (this.device.getPlatform() != Platform.ANDROID) {
      return undefined;
    }
    const foreground = await this.device.getCurrentBundleId();
    const isBrowser = Object.values(ANDROID_BROWSER_CONTEXTS).includes(context);
    if (
      isBrowser ? ANDROID_BROWSER_CONTEXTS[foreground] === context : context.includes(foreground)
    ) {
      return undefined;
    }
    return `${foreground} is in front, not ${isBrowser ? 'the browser' : 'the app it belongs to'}`;
  }

  /**
   * Switches to the context and window `attached` names, or says why it cannot: its app or
   * browser left the front, Appium no longer lists the context, or the window closed. When it
   * cannot, the session is left in NATIVE_APP, so the next `webView` call discovers a WebView
   * rather than run in whatever window the context fell back to.
   */
  private async switchToAttached(attached: AttachedPage): Promise<string | undefined> {
    const left = await this.leftFront(attached.context);
    if (left != null) {
      return left;
    }
    const listed = (await this.device.contexts()).map(contextName);
    if (!listed.includes(attached.context)) {
      return `Appium no longer lists it (contexts: ${JSON.stringify(listed)})`;
    }
    await this.device.switchContext(attached.context);
    if (attached.window != null) {
      const windows = await this.device.getWindowHandles();
      if (!windows.includes(attached.window)) {
        await this.device.switchContext(NATIVE_CONTEXT);
        return `its window ${attached.window} is closed (windows: ${JSON.stringify(windows)})`;
      }
      await this.device.switchToWindow(attached.window);
    }
    return undefined;
  }

  /**
   * Binds the session to a live page and returns the context it bound. Use it whenever the page
   * behind the WebView may have changed underneath the test: after the app reloads or rebuilds
   * its WebView, after a relaunch, and to drive (or leave) a browser the app handed off to.
   *
   * Other `webView` calls only check that *some* WEBVIEW context is current, which is still true
   * once the page behind it is gone. This switches to `NATIVE_APP` and back every attempt —
   * Appium skips its own check for a dead page when asked for the context it is already in —
   * then retries until the page reports `document.readyState` `interactive` or `complete` and
   * `probeSelector`, if given, is in its DOM.
   *
   * Other `webView` calls never bind a browser on their own: a browser's page is driven only
   * after `attach({ context })` names it. What `attach()` bound stays bound across native
   * `device` calls, which switch to NATIVE_APP, for as long as its context (and on Android its
   * window) lasts and, for a browser, while the browser stays in front. After that the next
   * `webView` call logs why and discovers a WebView again.
   *
   * **Usage:**
   * ```js
   * // The app rebuilt its WebView: wait for the login form of the new page.
   * await webView.attach({ probeSelector: '[data-testid="login-field"]' });
   *
   * // Drive the sign-in page a Chrome Custom Tab is showing.
   * await webView.attach({ context: 'WEBVIEW_chrome', pageUrl: '/oauth2/authorize' });
   *
   * // Bind the page a step opened, even at the URL of one that was already there.
   * await webView.attach({ page: await device.waitForWebPage({ notIn: before }) });
   * ```
   */
  @boxedStep
  async attach({
    context,
    pageUrl,
    page,
    probeSelector,
    timeout = ATTACH_TIMEOUT_MS,
    settle = false,
  }: AttachOptions = {}): Promise<string> {
    if (page != null && (context != null || pageUrl != null)) {
      throw new Error('attach: pass `page`, or `context` and `pageUrl`, not both.');
    }
    const deadline = Date.now() + timeout;
    this.attached = undefined;
    if (settle) {
      await this.waitForContextsToSettle(deadline);
    }

    let lastError: unknown;
    for (;;) {
      try {
        await this.device.switchContext(NATIVE_CONTEXT);
        // Which window is an Android page's is worked out from the page list, which only
        // NATIVE_APP can read.
        const listed =
          page != null && devToolsPageId(page) != null ? await this.device.webPages() : undefined;
        const target = page?.context ?? context ?? (await this.findWebViewContext());
        if (!target) {
          throw new Error(`no WebView context is available yet${await this.browserHint()}`);
        }
        await this.device.switchContext(target);
        if (page != null && listed != null) {
          await this.switchToWebPage(page, listed);
        } else if (pageUrl != null) {
          await this.switchToPage(pageUrl);
        }

        const readyState = await this.device.evaluate<string>('return document.readyState');
        if (readyState !== 'complete' && readyState !== 'interactive') {
          throw new Error(`document.readyState is "${readyState}"`);
        }
        if (probeSelector != null) {
          const found = await this.device.evaluate<boolean>(
            `return document.querySelector(${JSON.stringify(probeSelector)}) != null;`,
          );
          if (!found) {
            throw new Error(`"${probeSelector}" is not in the DOM yet`);
          }
        }

        const choseWindow = page != null || pageUrl != null;
        this.attached = {
          context: target,
          window:
            choseWindow && this.device.getPlatform() == Platform.ANDROID
              ? await this.currentWindow()
              : undefined,
        };
        console.log('[WebView] Attached to', target);
        return target;
      } catch (error) {
        if (
          (isInvalidSessionError(error) ||
            FATAL_SESSION_ERRORS.some((fatal) => errorMessage(error).includes(fatal))) &&
          !(await this.isRendererDrop(error))
        ) {
          throw error;
        }
        lastError = error;
      }
      if (Date.now() >= deadline) {
        break;
      }
      await delay(ATTACH_POLL_INTERVAL_MS);
    }

    const what = probeSelector != null ? `a page containing "${probeSelector}"` : 'a live page';
    // Every context Appium reports, unfiltered: otherwise the error reads as "there is no
    // WebView" when one plainly exists but belongs to an app that is not in front.
    let available = 'unknown';
    try {
      available = JSON.stringify((await this.device.contexts()).map(contextName));
    } catch {
      // The session is gone; the message still says what it can.
    }
    const where = page?.key ?? context;
    throw new Error(
      `attach: could not reach ${what}${where != null ? ` in ${where}` : ''} within ` +
        `${timeout}ms. Contexts Appium reports: ${available}. Last error: ${errorMessage(
          lastError,
        )}`,
    );
  }

  /** Blocks until the set of WEBVIEW contexts has not changed for `CONTEXTS_SETTLE_WINDOW_MS`. */
  private async waitForContextsToSettle(deadline: number): Promise<void> {
    const webViews = async () =>
      JSON.stringify(
        (await this.device.contexts())
          .map(contextName)
          .filter((name) => name.includes('WEBVIEW'))
          .sort(),
      );

    let previous = await webViews();
    let unchangedSince = Date.now();
    while (Date.now() < deadline && Date.now() - unchangedSince < CONTEXTS_SETTLE_WINDOW_MS) {
      await delay(CONTEXTS_SETTLE_SAMPLE_MS);
      const current = await webViews();
      if (current !== previous) {
        previous = current;
        unchangedSince = Date.now();
      }
    }
  }

  /**
   * Points the bound context at the page (window) whose URL matches. Throws, for the caller to
   * retry, while there is none: a freshly opened tab takes a moment to be listed.
   */
  private async switchToPage(pageUrl: string | RegExp): Promise<void> {
    const seen: string[] = [];
    for (const handle of await this.device.getWindowHandles()) {
      await this.device.switchToWindow(handle);
      const url = await this.device.getUrl();
      if (urlMatches(url, pageUrl)) {
        return;
      }
      seen.push(displayUrl(url));
    }
    throw new Error(`no page matching ${String(pageUrl)} yet; open pages: ${JSON.stringify(seen)}`);
  }

  /**
   * Points the bound context at an Android page's own window, `listed` being `device.webPages()`
   * from just before: one context spans every page of a WebView or browser.
   *
   * A WebView lists its pages under the DevTools target id chromedriver names their windows after
   * (`CDwindow-<id>` in older chromedrivers), which tells apart two pages at the same URL. Chrome
   * lists its tabs by number instead (`WEBVIEW_chrome#4`), so when none of the context's pages is
   * listed under a window, the window is the one at the page's current URL, and two windows at
   * that URL cannot be told apart. Throws, for the caller to retry, while there is no window.
   */
  private async switchToWebPage(page: WebPage, listed: WebPage[]): Promise<void> {
    const current = listed.find((candidate) => candidate.key === page.key);
    if (current == null) {
      throw new Error(`page ${page.key} is no longer listed`);
    }
    const handles = await this.device.getWindowHandles();
    const windowOf = (candidate: WebPage) => {
      const id = devToolsPageId(candidate);
      return handles.find((handle) => handle === id || handle === `CDwindow-${id}`);
    };

    const own = windowOf(current);
    if (own != null) {
      await this.device.switchToWindow(own);
      return;
    }
    if (listed.some((sibling) => sibling.context === page.context && windowOf(sibling) != null)) {
      throw new Error(`no window for page ${page.key} yet; windows: ${JSON.stringify(handles)}`);
    }

    const atUrl: string[] = [];
    for (const handle of handles) {
      await this.device.switchToWindow(handle);
      if ((await this.device.getUrl()) === current.url) {
        atUrl.push(handle);
      }
    }
    if (atUrl.length !== 1) {
      throw new Error(
        `no single window for page ${page.key}: none is listed under its id, and ` +
          `${atUrl.length} are at ${displayUrl(current.url)}`,
      );
    }
    await this.device.switchToWindow(atUrl[0]!);
  }

  /** The window the bound context is on, or `undefined` where windows cannot be read. */
  private async currentWindow(): Promise<string | undefined> {
    try {
      return await this.device.getCurrentWindowHandle();
    } catch {
      return undefined;
    }
  }

  /**
   * Whether `error` is chromedriver's session dying with the page's renderer while Appium's
   * session lives on.
   *
   * Once a WebView's renderer drops its DevTools connection, chromedriver answers "invalid
   * session id: session deleted as the browser has closed the connection". On Android it reads
   * like a dead session, but only the chromedriver session behind the WEBVIEW context is gone:
   * Appium's own session still answers, and switching to NATIVE_APP and back makes Appium start
   * a new chromedriver. This tells the two apart by asking Appium. Android only: on iOS the
   * WebView is driven by XCUITest itself, so "invalid session id" means the session is gone.
   */
  private async isRendererDrop(error: unknown): Promise<boolean> {
    if (this.device.getPlatform() != Platform.ANDROID || !isInvalidSessionError(error)) {
      return false;
    }
    try {
      await this.device.getCurrentContext();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Binds again, from NATIVE_APP, what was bound before a renderer drop or a closed window: the
   * context and window `attach()` bound, else whatever discovery finds. Throws, after forgetting
   * the attached page, when what `attach()` bound is gone, rather than run the action on another
   * page. `cause` opens the error.
   */
  private async rebind(cause: string): Promise<void> {
    const attached = this.attached;
    if (attached == null) {
      await this.ensureWebViewContext();
      return;
    }
    const gone = await this.switchToAttached(attached);
    if (gone != null) {
      this.attached = undefined;
      throw new Error(
        `${cause}, and ${attached.context}, which attach() bound, cannot be bound again: ` +
          `${gone}. Call webView.attach() to bind the page to use now.`,
      );
    }
  }

  /**
   * Helper method to recover from window closure by resetting WebView context.
   * Uses async-retry to handle transient failures.
   *
   * A renderer drop on Android (see `isRendererDrop()`) is recovered the same way: hopping
   * through NATIVE_APP makes Appium replace the dead chromedriver session. Every other error
   * fails at once, rethrown as it was thrown so that its class (a locator's `TimeoutError`,
   * which `expect(...).not.toBeVisible()` tells apart from a real failure) and stack survive.
   */
  private async recoverFromWindowClosure<T>(operation: () => Promise<T>): Promise<T> {
    return await retry(
      async (bail) => {
        try {
          return await operation();
        } catch (error) {
          if (await this.isRendererDrop(error)) {
            console.log('[WebView] The WebView renderer dropped its connection. Re-attaching...');
            try {
              await this.device.switchContext(NATIVE_CONTEXT);
              await this.rebind('The WebView renderer dropped its connection');
            } catch (rebindError) {
              bail(rebindError as Error);
              return undefined as T;
            }
            // The locator gave up on the dead session; the next attempt runs on the new one.
            throw error;
          }
          if (!isNoSuchWindowError(error)) {
            // We don't want to retry all errors. Only those related to window closure
            bail(error as Error);
            return undefined as T;
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

          try {
            await this.device.switchContext(NATIVE_CONTEXT);
            console.log('[WebView] Switched to NATIVE_APP');
            await this.rebind('The window the WebView was on closed');
            console.log('[WebView] Re-established WebView context');
          } catch (rebindError) {
            bail(rebindError as Error);
            return undefined as T;
          }

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

  locator({ selector, findStrategy, textToMatch, description }: LocatorQuery): AppwrightLocator {
    const originalLocator = this.device.createLocator({
      selector,
      findStrategy,
      textToMatch,
      description,
      web: true,
      wrap: (child) => this.wrapWithContextSwitch(child),
    });
    // Wrap all locator methods to ensure webview context
    return this.wrapWithContextSwitch(originalLocator);
  }

  /**
   * Locate an element by its `aria-label`. Defaults to an exact match.
   *
   * **Usage:**
   * ```js
   * await webView.getByLabel('Stations').tap();
   * await webView.getByLabel('Station', { exact: false }).tap();
   * ```
   *
   * @param label - The accessible label
   * @param options - `exact` (default `true`); `editable` is ignored in a WebView
   * @returns AppwrightLocator
   */
  getByLabel(label: string, options: LabelOptions = {}): AppwrightLocator {
    return this.locator(webLabelQuery(label, options));
  }

  /**
   * Wraps a locator to automatically switch to webview context before any action
   */
  private wrapWithContextSwitch(locator: Locator): AppwrightLocator {
    const self = this;
    return new Proxy(locator, {
      get(target, prop) {
        const original = target[prop as keyof AppwrightLocator];

        // `getByText()` and friends only build a locator; the child comes back wrapped.
        if (CHAIN_METHODS.has(prop)) {
          return (original as Function).bind(target);
        }

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
   * await webView.getByTestId('login-field').fill('0000');
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
    return this.locator(webTestIdQuery(testId));
  }

  /**
   * Locate an element by its text, the way Playwright's `getByText()` does: the element whose
   * whitespace-normalised text matches while none of its children's does. `<li><b>Device</b></li>`
   * yields the `<b>`, not the `<li>` and every ancestor up to `<body>`. Text in `<script>`,
   * `<style>` and `<head>` (the page title) never matches; an `<input type="submit">` matches by
   * its value.
   *
   * Defaults to a substring match; `exact: true` compares the whole text. Unlike Playwright, the
   * match is case-sensitive, as `device.getByText()` is; a `RegExp` is tested against the
   * normalised text, so `/^save$/i` covers the rest.
   *
   * **Usage:**
   * ```js
   * // Whole text, whitespace-normalised
   * await webView.getByText('Submit', { exact: true }).tap();
   *
   * // Substring (default)
   * await webView.getByText('Welcome').tap();
   *
   * // RegExp
   * await expect(webView.getByText(/^User \d+$/)).toBeVisible();
   * ```
   *
   * @param text - String or RegExp to match against the element's text
   * @param options - `exact` (default `false`)
   * @returns AppwrightLocator
   */
  getByText(text: string | RegExp, options: TextOptions = {}): AppwrightLocator {
    return this.locator(webTextQuery(text, options));
  }

  /**
   * Locate an element by its ARIA role and accessible name, the way Playwright's `getByRole()`
   * does. The role is the element's `role` attribute or its implicit HTML one — `<button>` and
   * `<input type="submit">` are buttons, `<h1>`–`<h6>` headings, `<a href>` a link,
   * `<input type="checkbox">` a checkbox, and so on; `menu` and `menuitem` come from `role`
   * alone. Elements hidden from assistive technology (`aria-hidden="true"`, `display: none`,
   * `visibility: hidden`) are skipped.
   *
   * `name` is the accessible name (see `RoleOptions.name`): an icon button's `aria-label`, a
   * button's or heading's text. Matched whole by default — `exact: false` for a substring —
   * case-sensitive, after whitespace normalisation.
   *
   * **Usage:**
   * ```js
   * await webView.getByRole('button', { name: 'Menu' }).tap();
   * await expect(webView.getByRole('heading', { name: 'Device Settings', level: 2 })).toBeVisible();
   * await webView.getByRole('menu').getByRole('button', { name: 'Settings' }).tap();
   * ```
   */
  getByRole(role: AriaRole, options: RoleOptions = {}): AppwrightLocator {
    return this.locator(webRoleQuery(role, options));
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
      selector: `[placeholder="${escapeQuotes(text)}"]`,
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
   * Recovers the way locator actions do: after a closed window or an Android renderer drop,
   * the WebView is bound again and the script runs once more, so a script that may have run
   * before the failure should be safe to run twice.
   *
   * @param script - JavaScript code to execute (string or function)
   * @returns Result of the script execution
   */
  @boxedStep
  async evaluate<T = any>(script: string | Function): Promise<T> {
    await this.ensureWebViewContext();
    return await this.recoverFromWindowClosure(() => this.device.evaluate<T>(script));
  }

  /**
   * The WEBVIEW context to bind, or `undefined` while there is none.
   *
   * On Android the chromedriver behind Appium sees every debuggable WebView on the device — the
   * system browser, background apps, widgets — so only those of the app in the foreground count,
   * and a browser in front is never bound this way (see `ANDROID_BROWSER_CONTEXTS`). XCUITest
   * lists the app's own WebViews only, so iOS takes the first one.
   */
  private async findWebViewContext(): Promise<string | undefined> {
    const foreground =
      this.device.getPlatform() == Platform.ANDROID
        ? await this.device.getCurrentBundleId()
        : undefined;
    const webViews = (await this.device.contexts())
      .map(contextName)
      .filter((name) => name.includes('WEBVIEW'));
    const contexts = webViews.filter((name) => !foreground || name.includes(foreground));
    console.log('[WebView] Available contexts from Appium:', contexts);
    const skipped = webViews.filter((name) => !contexts.includes(name));
    if (skipped.length > 0) {
      console.log(
        `[WebView] Skipping ${skipped.join(', ')}: not ${foreground}'s, the app in front.`,
      );
    }
    const browser = foreground != null ? ANDROID_BROWSER_CONTEXTS[foreground] : undefined;
    if (browser != null && contexts.length === 0) {
      console.log(
        `[WebView] ${foreground} is in front; a browser is bound only by ` +
          `webView.attach({ context: '${browser}' }).`,
      );
    }
    return contexts[0];
  }

  /** How to bind the browser in front, for an error that found no WebView; '' otherwise. */
  private async browserHint(): Promise<string> {
    if (this.device.getPlatform() != Platform.ANDROID) {
      return '';
    }
    try {
      const foreground = await this.device.getCurrentBundleId();
      const browser = ANDROID_BROWSER_CONTEXTS[foreground];
      return browser != null
        ? `. ${foreground} is in front: bind its page with webView.attach({ context: '${browser}' })`
        : '';
    } catch {
      return '';
    }
  }

  /**
   * Discovers a WebView and binds it, retrying for about half a minute while there is none — or
   * for `BROWSER_IN_FRONT_GRACE_MS` while a browser is in front, which discovery never binds.
   */
  private async switchToWebviewContext(): Promise<void> {
    this.attached = undefined;
    const started = Date.now();
    await retry(
      async (bail) => {
        const webviewContext = await this.findWebViewContext();
        if (!webviewContext) {
          const hint = await this.browserHint();
          const error = new Error(
            `No WebView context found. Make sure your app has a WebView loaded${hint}.`,
          );
          if (hint !== '' && Date.now() - started >= BROWSER_IN_FRONT_GRACE_MS) {
            bail(error);
            return;
          }
          throw error;
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
}
