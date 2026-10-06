import { afterEach, describe, expect, Mock, test, vi } from 'vitest';
//@ts-ignore
import { Client as WebDriverClient } from 'webdriver';

import { Device } from '../device';
import { WebView } from '../webView';

type MockClient = WebDriverClient & Record<string, Mock>;

const APP = 'co.tulip.player';

type PageState = { readyState?: string; probe?: boolean };

/**
 * A session whose current context follows `switchAppiumContext`, with `pages` of window handle
 * -> URL, and a page script answering readyState / the probe from `page`.
 */
function mockClient({
  isAndroid = true,
  contexts = ['NATIVE_APP', `WEBVIEW_${APP}`],
  foreground = APP,
  pages = { 'CDwindow-1': 'https://example.com/' } as Record<string, string>,
  page = (): PageState => ({ readyState: 'complete', probe: true }),
  devTools = (): unknown => [],
}: {
  isAndroid?: boolean;
  contexts?: unknown[] | (() => unknown[]);
  foreground?: string;
  pages?: Record<string, string>;
  page?: () => PageState;
  /** What `mobile: getContexts` answers. */
  devTools?: () => unknown;
} = {}): MockClient {
  let current = 'NATIVE_APP';
  let window = Object.keys(pages)[0];
  //@ts-ignore partial mock
  return {
    isAndroid,
    getAppiumContext: vi.fn(async () => current),
    switchAppiumContext: vi.fn(async (name: string) => {
      current = name;
    }),
    getAppiumContexts: vi.fn(async () => (typeof contexts === 'function' ? contexts() : contexts)),
    getWindowHandles: vi.fn(async () => Object.keys(pages)),
    switchToWindow: vi.fn(async (handle: string) => {
      window = handle;
    }),
    getUrl: vi.fn(async () => pages[window!]),
    executeScript: vi.fn(async (script: string) => {
      if (script === 'mobile: getCurrentPackage') {
        return foreground;
      }
      if (script === 'mobile: getContexts') {
        return devTools();
      }
      if (script.includes('readyState')) {
        return page().readyState;
      }
      if (script.includes('querySelector')) {
        return page().probe;
      }
      return undefined;
    }),
  } as MockClient;
}

function webView(client: WebDriverClient): WebView {
  return new WebView(new Device(client, APP, { expectTimeout: 1_000 }, 'emulator'));
}

const switches = (client: MockClient) =>
  (client.switchAppiumContext as Mock).mock.calls.map((c) => c[0]);

afterEach(() => {
  vi.useRealTimers();
});

describe('webView.attach', () => {
  test("hops to NATIVE_APP, binds the foreground app's WebView, checks the page", async () => {
    const client = mockClient();
    expect(await webView(client).attach()).toBe(`WEBVIEW_${APP}`);
    expect(switches(client)).toEqual(['NATIVE_APP', `WEBVIEW_${APP}`]);
  });

  test('hops through NATIVE_APP even when the named context is already current', async () => {
    const client = mockClient({ contexts: ['NATIVE_APP', 'WEBVIEW_chrome'] });
    await client.switchAppiumContext('WEBVIEW_chrome');
    (client.switchAppiumContext as Mock).mockClear();

    await webView(client).attach({ context: 'WEBVIEW_chrome' });
    expect(switches(client)).toEqual(['NATIVE_APP', 'WEBVIEW_chrome']);
  });

  test('picks the page whose URL matches, by substring or RegExp', async () => {
    const pages = {
      'CDwindow-1': 'chrome-native://newtab/',
      'CDwindow-2': 'https://sso.example.com/open-player?x=1',
    };
    const client = mockClient({ contexts: ['NATIVE_APP', 'WEBVIEW_chrome'], pages });
    await webView(client).attach({ context: 'WEBVIEW_chrome', pageUrl: '/open-player' });
    expect((client.switchToWindow as Mock).mock.calls.map((c) => c[0])).toEqual([
      'CDwindow-1',
      'CDwindow-2',
    ]);

    const again = mockClient({ contexts: ['NATIVE_APP', 'WEBVIEW_chrome'], pages });
    await webView(again).attach({ context: 'WEBVIEW_chrome', pageUrl: /sso\.example\.com/g });
    expect(again.switchToWindow).toHaveBeenLastCalledWith('CDwindow-2');
  });

  describe('page', () => {
    const PLAYER = 'https://acme.tulip.co/player';
    const APP_CONTEXT = `WEBVIEW_${APP}`;
    const REBUILT = { context: APP_CONTEXT, key: `${APP_CONTEXT}#B2`, url: PLAYER, title: '' };
    /** UiAutomator2's `mobile: getContexts`: one WebView or browser, its DevTools pages nested. */
    const listing =
      (webviewName: string, ...pages: { id: string; url: string }[]) =>
      (): unknown =>
        [{ webviewName, pages: pages.map((p) => ({ type: 'page', title: '', ...p })) }];
    const windows = (client: MockClient) =>
      (client.switchToWindow as Mock).mock.calls.map((c) => c[0]);

    test('WebView: picks its window by DevTools id among pages at the same URL', async () => {
      const devTools = listing(APP_CONTEXT, { id: 'A1', url: PLAYER }, { id: 'B2', url: PLAYER });
      const client = mockClient({ pages: { A1: PLAYER, B2: PLAYER }, devTools });
      expect(await webView(client).attach({ page: REBUILT })).toBe(APP_CONTEXT);
      expect(switches(client)).toEqual(['NATIVE_APP', APP_CONTEXT]);
      expect(windows(client)).toEqual(['B2']);

      const older = mockClient({
        pages: { 'CDwindow-A1': PLAYER, 'CDwindow-B2': PLAYER },
        devTools,
      });
      await webView(older).attach({ page: REBUILT });
      expect(windows(older)).toEqual(['CDwindow-B2']);
    });

    test('WebView: keeps trying while chromedriver lists only the other page', async () => {
      const devTools = listing(APP_CONTEXT, { id: 'A1', url: PLAYER }, { id: 'B2', url: PLAYER });
      const client = mockClient({ pages: { A1: PLAYER, B2: PLAYER }, devTools });
      (client.getWindowHandles as Mock).mockResolvedValueOnce(['A1']);
      vi.useFakeTimers();
      const attached = webView(client).attach({ page: REBUILT });
      await vi.runAllTimersAsync();
      await attached;
      expect(client.getWindowHandles).toHaveBeenCalledTimes(2);
      // Never A1, even though it is at the same URL.
      expect(windows(client)).toEqual(['B2']);
    });

    test("Chrome: a numbered tab is the window at the tab's current URL", async () => {
      // The tab redirected since waitForWebPage returned it.
      const devTools = listing(
        'WEBVIEW_chrome',
        { id: '4', url: 'https://example.com/' },
        { id: '5', url: 'https://sso.example.com/done' },
      );
      const client = mockClient({
        contexts: ['NATIVE_APP', 'WEBVIEW_chrome'],
        pages: { '9F2C': 'https://example.com/', '0B7E': 'https://sso.example.com/done' },
        devTools,
      });
      const tab = {
        context: 'WEBVIEW_chrome',
        key: 'WEBVIEW_chrome#5',
        url: 'https://sso.example.com/start',
        title: '',
      };
      await webView(client).attach({ page: tab });
      expect(windows(client).at(-1)).toBe('0B7E');
    });

    test('Chrome: two tabs at the URL cannot be told apart', async () => {
      const url = 'https://example.com/';
      const client = mockClient({
        contexts: ['NATIVE_APP', 'WEBVIEW_chrome'],
        pages: { '9F2C': url, '0B7E': url },
        devTools: listing('WEBVIEW_chrome', { id: '4', url }, { id: '5', url }),
      });
      const tab = { context: 'WEBVIEW_chrome', key: 'WEBVIEW_chrome#5', url, title: '' };
      vi.useFakeTimers();
      const attached = webView(client)
        .attach({ page: tab, timeout: 3_000 })
        .catch((e: Error) => e);
      await vi.runAllTimersAsync();
      expect(((await attached) as Error).message).toContain(
        'Last error: no single window for page WEBVIEW_chrome#5: none is listed under its id, ' +
          'and 2 are at https://example.com/',
      );
    });

    test('times out naming the page once it is no longer listed', async () => {
      const client = mockClient({ devTools: listing(APP_CONTEXT, { id: 'A1', url: PLAYER }) });
      vi.useFakeTimers();
      const attached = webView(client)
        .attach({ page: REBUILT, timeout: 3_000 })
        .catch((e: Error) => e);
      await vi.runAllTimersAsync();
      const error = (await attached) as Error;
      expect(error.message).toContain(`could not reach a live page in ${APP_CONTEXT}#B2 within`);
      expect(error.message).toContain(`Last error: page ${APP_CONTEXT}#B2 is no longer listed`);
    });

    test('iOS: the context is the page, so no window is picked', async () => {
      const client = mockClient({ isAndroid: false, contexts: ['NATIVE_APP', 'WEBVIEW_61028.2'] });
      const page = { context: 'WEBVIEW_61028.2', key: 'WEBVIEW_61028.2', url: PLAYER, title: '' };
      expect(await webView(client).attach({ page })).toBe('WEBVIEW_61028.2');
      expect(switches(client)).toEqual(['NATIVE_APP', 'WEBVIEW_61028.2']);
      expect(client.getWindowHandles).not.toHaveBeenCalled();
      expect(client.executeScript).not.toHaveBeenCalledWith(
        'mobile: getContexts',
        expect.anything(),
      );
    });

    test('is not combined with context or pageUrl', async () => {
      const client = mockClient();
      await expect(webView(client).attach({ page: REBUILT, pageUrl: '/player' })).rejects.toThrow(
        'attach: pass `page`, or `context` and `pageUrl`, not both.',
      );
      expect(client.switchAppiumContext).not.toHaveBeenCalled();
    });
  });

  test('keeps trying until the page is ready and holds the probe', async () => {
    const states: PageState[] = [
      { readyState: 'loading' },
      { readyState: 'complete', probe: false },
      { readyState: 'complete', probe: true },
    ];
    let tick = 0;
    const client = mockClient({
      page: () => states[Math.min(Math.floor(tick++ / 2), states.length - 1)]!,
    });
    vi.useFakeTimers();
    const attached = webView(client).attach({ probeSelector: '[data-testid="login-badgeid"]' });
    await vi.runAllTimersAsync();
    expect(await attached).toBe(`WEBVIEW_${APP}`);
    const probes = (client.executeScript as Mock).mock.calls.filter(([s]) =>
      s.includes('querySelector'),
    );
    expect(probes.at(-1)![0]).toBe(
      'return document.querySelector("[data-testid=\\"login-badgeid\\"]") != null;',
    );
  });

  test('a dead session fails at once', async () => {
    const client = mockClient();
    (client.switchAppiumContext as Mock).mockRejectedValue(new Error('invalid session id'));
    await expect(webView(client).attach({ timeout: 60_000 })).rejects.toThrow('invalid session id');
    expect(client.switchAppiumContext).toHaveBeenCalledTimes(1);
  });

  test('times out naming what it waited for, every context, and the last error', async () => {
    const client = mockClient({
      contexts: ['NATIVE_APP', 'WEBVIEW_com.other.app'],
    });
    await expect(webView(client).attach({ probeSelector: '#x', timeout: 0 })).rejects.toThrow(
      'attach: could not reach a page containing "#x" within 0ms. Contexts Appium reports: ' +
        '["NATIVE_APP","WEBVIEW_com.other.app"]. Last error: no WebView context is available yet',
    );
  });

  test('settle waits for the WEBVIEW contexts to stop changing first', async () => {
    // iOS relaunch: the old page is listed for a few samples, then replaced.
    let samples = 0;
    const client = mockClient({
      isAndroid: false,
      contexts: () =>
        ++samples <= 3 ? ['NATIVE_APP', 'WEBVIEW_1.1'] : ['NATIVE_APP', 'WEBVIEW_2.1'],
    });
    vi.useFakeTimers();
    const attached = webView(client).attach({ settle: true });
    await vi.runAllTimersAsync();
    expect(await attached).toBe('WEBVIEW_2.1');
    // Changed at the 4th sample, then five more unchanged seconds before the attach.
    expect(samples).toBeGreaterThanOrEqual(9);
  });
});

describe('WebView discovery', () => {
  test("with Chrome in front, Chrome's WEBVIEW_chrome is bound, not the app's", async () => {
    const client = mockClient({
      contexts: ['NATIVE_APP', `WEBVIEW_${APP}`, 'WEBVIEW_chrome'],
      foreground: 'com.android.chrome',
    });
    expect(await webView(client).attach()).toBe('WEBVIEW_chrome');
  });

  test('other apps’ WebViews are ignored on Android; detailed contexts are named by id', async () => {
    const client = mockClient({
      contexts: [
        { id: 'NATIVE_APP' },
        { id: 'WEBVIEW_com.other.app', title: 'Other' },
        { id: `WEBVIEW_${APP}`, title: 'Player' },
      ],
    });
    const log = vi.spyOn(console, 'log');
    await webView(client)
      .getByTestId('x')
      .getElement()
      .catch(() => undefined);
    expect(switches(client)).toContain(`WEBVIEW_${APP}`);
    expect(switches(client)).not.toContain('WEBVIEW_com.other.app');
    // Said out loud rather than dropped silently.
    expect(log).toHaveBeenCalledWith(
      `[WebView] Skipping WEBVIEW_com.other.app: not ${APP}'s, the app in front.`,
    );
    log.mockRestore();
  });
});
