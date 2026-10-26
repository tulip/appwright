import { describe, expect, Mock, test, vi } from 'vitest';
//@ts-ignore
import { Client as WebDriverClient } from 'webdriver';

import { Device } from '../device';
import { devToolsPageId, toWebPages } from '../device/web-pages';

type MockClient = WebDriverClient & Record<string, Mock>;

/** XCUITest: one context per page. */
const IOS_CONTEXTS = [
  { id: 'NATIVE_APP' },
  { id: 'WEBVIEW_61028.1', title: 'Example', url: 'https://app.example.com/main', bundleId: 'x' },
];

/** UiAutomator2: one entry per WebView, its DevTools targets nested. */
function androidContexts(...pages: { id: string; url: string; type?: string }[]) {
  return [
    {
      proc: '@webview_devtools_remote_123',
      webview: 'WEBVIEW_123',
      webviewName: 'WEBVIEW_com.example.app',
      pages: pages.map((page) => ({ title: '', type: 'page', ...page })),
    },
    { proc: '@other', webview: 'WEBVIEW_456', webviewName: null, pages: [] },
  ];
}

function mockClient(isAndroid: boolean, ...answers: unknown[]): MockClient {
  const getContexts = vi.fn();
  for (const answer of answers.slice(0, -1)) {
    getContexts.mockResolvedValueOnce(answer);
  }
  getContexts.mockResolvedValue(answers.at(-1));
  //@ts-ignore partial mock
  return {
    isAndroid,
    getAppiumContext: vi.fn().mockResolvedValue('NATIVE_APP'),
    switchAppiumContext: vi.fn().mockResolvedValue(undefined),
    executeScript: vi.fn().mockImplementation(async (command: string) => {
      expect(command).toBe('mobile: getContexts');
      return await getContexts();
    }),
  } as MockClient;
}

function device(client: WebDriverClient): Device {
  return new Device(client, 'com.example.app', { expectTimeout: 1_000 }, 'emulator');
}

describe('toWebPages', () => {
  test('iOS: every context but NATIVE_APP is a page', () => {
    expect(toWebPages(false, IOS_CONTEXTS)).toEqual([
      {
        context: 'WEBVIEW_61028.1',
        key: 'WEBVIEW_61028.1',
        url: 'https://app.example.com/main',
        title: 'Example',
      },
    ]);
  });

  test('Android: pages flattened under their context, other targets left out', () => {
    const raw = androidContexts(
      { id: 'A1', url: 'https://app.example.com/main' },
      { id: 'SW', url: 'https://app.example.com/sw.js', type: 'service_worker' },
    );
    expect(toWebPages(true, raw)).toEqual([
      {
        context: 'WEBVIEW_com.example.app',
        key: 'WEBVIEW_com.example.app#A1',
        url: 'https://app.example.com/main',
        title: '',
      },
    ]);
    expect(toWebPages(true, undefined)).toEqual([]);
  });

  test("devToolsPageId: the id after an Android key's context; none on iOS", () => {
    const [android] = toWebPages(true, androidContexts({ id: 'A1', url: 'https://x.test/' }));
    expect(devToolsPageId(android!)).toBe('A1');
    const [ios] = toWebPages(false, IOS_CONTEXTS);
    expect(devToolsPageId(ios!)).toBeUndefined();
  });
});

describe('webPages / waitForWebPage', () => {
  test('webPages reads the contexts from NATIVE_APP', async () => {
    const client = mockClient(false, IOS_CONTEXTS);
    (client.getAppiumContext as Mock).mockResolvedValue('WEBVIEW_61028.1');
    expect(await device(client).webPages()).toHaveLength(1);
    expect(client.switchAppiumContext).toHaveBeenCalledWith('NATIVE_APP');
  });

  test('waits past about:blank for the new page', async () => {
    const main = { id: 'A1', url: 'https://app.example.com/main' };
    const client = mockClient(
      true,
      androidContexts(main),
      androidContexts(main, { id: 'B2', url: 'about:blank' }),
      androidContexts(main, { id: 'B2', url: 'https://cdn.example.com/manual.pdf' }),
    );
    const d = device(client);
    const before = await d.webPages();

    const popup = await d.waitForWebPage({ notIn: before, url: /\.pdf$/, pollInterval: 1 });
    expect(popup).toEqual({
      context: 'WEBVIEW_com.example.app',
      key: 'WEBVIEW_com.example.app#B2',
      url: 'https://cdn.example.com/manual.pdf',
      title: '',
    });
    // `before`, then the popup on about:blank, then loaded.
    expect(client.executeScript).toHaveBeenCalledTimes(3);
  });

  test('without a url filter, still waits past about:blank', async () => {
    const main = { id: 'A1', url: 'https://app.example.com/main' };
    const client = mockClient(
      true,
      androidContexts(main),
      androidContexts(main, { id: 'B2', url: 'about:blank' }),
      androidContexts(main, { id: 'B2', url: 'https://app.example.com/help' }),
    );
    const d = device(client);
    const before = await d.webPages();

    const popup = await d.waitForWebPage({ notIn: before, pollInterval: 1 });
    expect(popup.url).toBe('https://app.example.com/help');
    expect(client.executeScript).toHaveBeenCalledTimes(3);
  });

  test('Android: a rebuilt WebView at a URL among notIn is new, by its key', async () => {
    const main = { id: 'A1', url: 'https://app.example.com/main' };
    const client = mockClient(true, androidContexts(main, { id: 'B2', url: main.url }));
    const rebuilt = await device(client).waitForWebPage({
      notIn: toWebPages(true, androidContexts(main)),
      timeout: 0,
    });
    expect(rebuilt.key).toBe('WEBVIEW_com.example.app#B2');
  });

  test('iOS: a second tab at a known URL is new, by its key', async () => {
    const tab = { ...IOS_CONTEXTS[1], id: 'WEBVIEW_61028.2' };
    const client = mockClient(false, [...IOS_CONTEXTS, tab]);
    const found = await device(client).waitForWebPage({
      notIn: toWebPages(false, IOS_CONTEXTS),
      timeout: 0,
    });
    expect(found.key).toBe('WEBVIEW_61028.2');
  });

  test('a known page that navigated is not new', async () => {
    const navigated = [IOS_CONTEXTS[0], { ...IOS_CONTEXTS[1], url: 'https://app.example.com/home' }];
    const client = mockClient(false, navigated);
    await expect(
      device(client).waitForWebPage({ notIn: toWebPages(false, IOS_CONTEXTS), timeout: 0 }),
    ).rejects.toThrow(
      'waitForWebPage: no new page with a loaded URL within 0ms. New pages seen: []',
    );
  });

  test('a new page that never matches is named in the timeout', async () => {
    const client = mockClient(false, [
      ...IOS_CONTEXTS,
      { id: 'WEBVIEW_61028.3', url: 'https://www.google.com/' },
    ]);
    await expect(
      device(client).waitForWebPage({
        notIn: toWebPages(false, IOS_CONTEXTS),
        url: '.pdf',
        timeout: 0,
      }),
    ).rejects.toThrow(
      'no new page with a URL matching .pdf within 0ms. New pages seen: ["https://www.google.com/"]',
    );
  });
});
