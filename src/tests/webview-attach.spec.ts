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
}: {
  isAndroid?: boolean;
  contexts?: unknown[] | (() => unknown[]);
  foreground?: string;
  pages?: Record<string, string>;
  page?: () => PageState;
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
