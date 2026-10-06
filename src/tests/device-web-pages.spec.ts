import { describe, expect, Mock, test, vi } from 'vitest';
//@ts-ignore
import { Client as WebDriverClient } from 'webdriver';

import { Device } from '../device';
import { toWebPages } from '../device/web-pages';

type MockClient = WebDriverClient & Record<string, Mock>;

/** XCUITest: one context per page. */
const IOS_CONTEXTS = [
  { id: 'NATIVE_APP' },
  { id: 'WEBVIEW_61028.1', title: 'Tulip', url: 'https://acme.tulip.co/player', bundleId: 'x' },
];

/** UiAutomator2: one entry per WebView, its DevTools targets nested. */
function androidContexts(...pages: { id: string; url: string; type?: string }[]) {
  return [
    {
      proc: '@webview_devtools_remote_123',
      webview: 'WEBVIEW_123',
      webviewName: 'WEBVIEW_co.tulip.player',
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
  return new Device(client, 'co.tulip.player', { expectTimeout: 1_000 }, 'emulator');
}

describe('toWebPages', () => {
  test('iOS: every context but NATIVE_APP is a page', () => {
    expect(toWebPages(false, IOS_CONTEXTS)).toEqual([
      {
        context: 'WEBVIEW_61028.1',
        key: 'WEBVIEW_61028.1',
        url: 'https://acme.tulip.co/player',
        title: 'Tulip',
      },
    ]);
  });

  test('Android: pages flattened under their context, other targets left out', () => {
    const raw = androidContexts(
      { id: 'A1', url: 'https://acme.tulip.co/player' },
      { id: 'SW', url: 'https://acme.tulip.co/sw.js', type: 'service_worker' },
    );
    expect(toWebPages(true, raw)).toEqual([
      {
        context: 'WEBVIEW_co.tulip.player',
        key: 'WEBVIEW_co.tulip.player#A1',
        url: 'https://acme.tulip.co/player',
        title: '',
      },
    ]);
    expect(toWebPages(true, undefined)).toEqual([]);
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
    const player = { id: 'A1', url: 'https://acme.tulip.co/player' };
    const client = mockClient(
      true,
      androidContexts(player),
      androidContexts(player, { id: 'B2', url: 'about:blank' }),
      androidContexts(player, { id: 'B2', url: 'https://cdn.example.com/manual.pdf' }),
    );
    const d = device(client);
    const before = await d.webPages();

    const popup = await d.waitForWebPage({ notIn: before, url: /\.pdf$/, pollInterval: 1 });
    expect(popup).toEqual({
      context: 'WEBVIEW_co.tulip.player',
      key: 'WEBVIEW_co.tulip.player#B2',
      url: 'https://cdn.example.com/manual.pdf',
      title: '',
    });
    // `before`, then the popup on about:blank, then loaded.
    expect(client.executeScript).toHaveBeenCalledTimes(3);
  });

  test('a known page under a new context, as iOS lists a reload, is not new', async () => {
    const reloaded = [IOS_CONTEXTS[0], { ...IOS_CONTEXTS[1], id: 'WEBVIEW_61028.2' }];
    const client = mockClient(false, reloaded);
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
