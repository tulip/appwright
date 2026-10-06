import { describe, expect, Mock, test, vi } from 'vitest';
//@ts-ignore
import { Client as WebDriverClient } from 'webdriver';

import { Device } from '../device';
import { SCRIPT_FIND_STRATEGY } from '../locator/queries';
import { ELEMENT_REFERENCE_ID } from '../types';
import { WebView } from '../webView';

type MockClient = WebDriverClient & Record<string, Mock>;

const el = (id: string) => ({ [ELEMENT_REFERENCE_ID]: id });

function mockClient(overrides: Record<string, unknown> = {}): MockClient {
  //@ts-ignore partial mock
  return {
    isAndroid: true,
    getAppiumContext: vi.fn().mockResolvedValue('NATIVE_APP'),
    switchAppiumContext: vi.fn().mockResolvedValue(undefined),
    findElements: vi.fn().mockResolvedValue([el('parent')]),
    findElementsFromElement: vi.fn().mockResolvedValue([el('child')]),
    executeScript: vi.fn().mockResolvedValue([el('child')]),
    getElementText: vi.fn().mockResolvedValue(''),
    isElementDisplayed: vi.fn().mockResolvedValue(true),
    elementClick: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as MockClient;
}

function device(client: WebDriverClient): Device {
  return new Device(client, 'com.example.app', { expectTimeout: 1_000 }, 'emulator');
}

describe('chaining native locators', () => {
  test('looks the child up inside the element the parent resolves to', async () => {
    const client = mockClient();
    const save = device(client).getById('print-dialog').getByText('Save');
    await save.tap();

    expect(client.findElements).toHaveBeenCalledWith(
      '-android uiautomator',
      'resourceId("print-dialog")',
    );
    expect(client.findElementsFromElement).toHaveBeenCalledWith(
      'parent',
      '-android uiautomator',
      'textContains("Save")',
    );
    expect(client.elementClick).toHaveBeenCalledWith('child');
  });

  test("tries the parent's other matches, last first, until one contains the child", async () => {
    const client = mockClient({
      findElements: vi.fn().mockResolvedValue([el('p1'), el('p2'), el('p3')]),
      findElementsFromElement: vi
        .fn()
        .mockImplementation(async (root: string) => (root === 'p2' ? [el('in-p2')] : [])),
    });
    expect(await device(client).getByLabel('Row').getByText('Delete').getElement()).toEqual(
      el('in-p2'),
    );
    expect((client.findElementsFromElement as Mock).mock.calls.map((c) => c[0])).toEqual([
      'p3',
      'p2',
    ]);
  });

  test('no parent match means no child match, without looking further', async () => {
    const client = mockClient({ findElements: vi.fn().mockResolvedValue([]) });
    await device(client).getById('dialog').getByText('OK').waitFor('hidden');
    expect(client.findElementsFromElement).not.toHaveBeenCalled();
  });

  test('a chained XPath is made relative to its root', async () => {
    const client = mockClient();
    // A RegExp without a literal group falls back to `//*`, filtered by text.
    await device(client)
      .getById('list')
      .getByText(/^\d+ items$/)
      .getElement();
    expect(client.findElementsFromElement).toHaveBeenCalledWith('parent', 'xpath', './/*');
  });

  test('getByTestId matches the id natively; getByRole is refused', () => {
    const list = device(mockClient()).getById('list');
    const item = list.getByTestId('row-1') as unknown as { selector: string };
    expect(item.selector).toBe('resourceId("row-1")');
    expect(() => list.getByRole('button')).toThrow('getByRole() needs a WebView locator');
  });
});

describe('chaining WebView locators', () => {
  function webView(client: MockClient): WebView {
    (client.getAppiumContext as Mock).mockResolvedValue('WEBVIEW_com.example.app');
    return new WebView(device(client));
  }

  test('a script query receives the parent element as its root', async () => {
    const client = mockClient();
    await webView(client)
      .getByTestId('player-menu')
      .getByRole('button', { name: 'Settings' })
      .tap();

    expect(client.findElements).toHaveBeenCalledWith('css selector', '[data-testid="player-menu"]');
    const [script, args] = (client.executeScript as Mock).mock.calls[0]!;
    expect(script).toContain('"role":"button"');
    expect(args).toEqual([el('parent')]);
    expect(client.elementClick).toHaveBeenCalledWith('child');
  });

  test('chains read as the calls that built them in errors', async () => {
    const client = mockClient({ executeScript: vi.fn().mockResolvedValue([]) });
    const settings = webView(client)
      .getByTestId('player-menu')
      .getByRole('button', { name: 'Settings' });
    await expect(settings.tap({ timeout: 10 })).rejects.toThrow(
      'Failed to tap: Element [data-testid="player-menu"] >> getByRole("button", { name: "Settings" }) not visible',
    );
  });

  test('chaining is synchronous through the proxy and keeps the WebView context switch', async () => {
    const client = mockClient();
    (client.getAppiumContext as Mock).mockResolvedValue('NATIVE_APP');
    client.getAppiumContexts = vi.fn().mockResolvedValue(['NATIVE_APP', 'WEBVIEW_com.example.app']);
    (client.executeScript as Mock).mockImplementation(async (script: string) =>
      script === 'mobile: getCurrentPackage' ? 'com.example.app' : [el('child')],
    );
    const menu = new WebView(device(client)).getByRole('menu');
    const item = menu.getByText('Device', { exact: true });
    expect(item).not.toBeInstanceOf(Promise);

    await item.getElement();
    expect(client.switchAppiumContext).toHaveBeenCalledWith('WEBVIEW_com.example.app');
    const scripts = (client.executeScript as Mock).mock.calls.filter(
      ([script]) => typeof script === 'string' && script.startsWith('return ('),
    );
    // getByRole('menu') from the document, then getByText inside the menu it found.
    expect(scripts.map(([, args]) => args)).toEqual([[null], [el('child')]]);
  });

  test('web getByLabel and getByTestId escape quotes', () => {
    const view = webView(mockClient());
    const field = view.getByLabel('Say "hi"') as unknown as { selector: string };
    expect(field.selector).toBe('[aria-label="Say \\"hi\\""]');
    const scoped = view.css('form').getByTestId('a"b') as unknown as {
      selector: string;
      findStrategy: string;
    };
    expect(scoped.selector).toBe('[data-testid="a\\"b"]');
    expect(scoped.findStrategy).toBe('css selector');
    expect((view.getByText('x') as unknown as { findStrategy: string }).findStrategy).toBe(
      SCRIPT_FIND_STRATEGY,
    );
  });
});
