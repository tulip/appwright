import { describe, expect, Mock, test, vi } from 'vitest';
//@ts-ignore
import { Client as WebDriverClient } from 'webdriver';

import { Locator } from '../locator';
import { ELEMENT_REFERENCE_ID } from '../types';
import { TimeoutError } from '../types/errors';

const ELEMENT = { [ELEMENT_REFERENCE_ID]: 'element-id' };
const TIMEOUTS = { expectTimeout: 1_000 };

type MockClient = WebDriverClient & Record<string, Mock>;

const calls = (fn: unknown): unknown[][] => (fn as Mock).mock.calls;

function mockClient(overrides: Record<string, unknown> = {}): MockClient {
  //@ts-ignore partial mock
  return {
    isAndroid: true,
    findElements: vi.fn().mockResolvedValue([ELEMENT]),
    isElementDisplayed: vi.fn().mockResolvedValue(true),
    elementClick: vi.fn().mockResolvedValue(undefined),
    elementClear: vi.fn().mockResolvedValue(undefined),
    elementSendKeys: vi.fn().mockResolvedValue(undefined),
    getElementAttribute: vi.fn().mockResolvedValue(''),
    executeScript: vi.fn().mockResolvedValue(''),
    ...overrides,
  } as MockClient;
}

/** An Android field whose `text` reads `value` and whose hint is unrelated. */
const textAttr = (value: string) =>
  vi
    .fn()
    .mockImplementation(async (_id: string, name: string) => (name === 'text' ? value : 'hint'));

/** Successive `text` readings; the hint stays unrelated. */
const textAttrSequence = (...values: string[]) => {
  let i = 0;
  return vi
    .fn()
    .mockImplementation(async (_id: string, name: string) =>
      name === 'text' ? values[Math.min(i++, values.length - 1)] : 'hint',
    );
};

function nativeLocator(client: WebDriverClient) {
  return new Locator(client, TIMEOUTS, '//field', 'xpath');
}

function webLocator(client: WebDriverClient) {
  return new Locator(client, TIMEOUTS, '#field', 'css selector', undefined, true);
}

describe("waitFor('hidden')", () => {
  test('resolves at once when nothing matches', async () => {
    const client = mockClient({ findElements: vi.fn().mockResolvedValue([]) });
    await nativeLocator(client).waitFor('hidden');
    expect(client.findElements).toHaveBeenCalledTimes(1);
    expect(client.isElementDisplayed).not.toHaveBeenCalled();
  });

  test('resolves when the element exists but is not displayed', async () => {
    const client = mockClient({ isElementDisplayed: vi.fn().mockResolvedValue(false) });
    await nativeLocator(client).waitFor('hidden');
    expect(client.isElementDisplayed).toHaveBeenCalledWith('element-id');
  });

  test('a stale element is retried rather than read as hidden', async () => {
    class StaleError extends Error {
      name = 'stale element reference';
    }
    const client = mockClient({
      findElements: vi.fn().mockResolvedValueOnce([ELEMENT]).mockResolvedValue([]),
      isElementDisplayed: vi.fn().mockRejectedValue(new StaleError('gone')),
    });
    await nativeLocator(client).waitFor('hidden');
    // First tick: found + stale → retry. Second tick: nothing matches → hidden.
    expect(client.findElements).toHaveBeenCalledTimes(2);
  });

  test('times out while the element stays displayed, naming the element', async () => {
    const client = mockClient();
    const error = await nativeLocator(client)
      .waitFor('hidden', { timeout: 1_000 })
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toBe('Element "//field" was still on the screen after 1000ms');
  });
});

describe('fill', () => {
  test('native: taps, clears, types, then reads the value back', async () => {
    const client = mockClient({
      getElementAttribute: vi
        .fn()
        .mockImplementation((_id, name) => (name === 'text' ? 'hello' : 'Search…')),
    });
    await nativeLocator(client).fill('hello');

    expect(client.elementClick).toHaveBeenCalledWith('element-id');
    expect(client.elementClear).toHaveBeenCalledWith('element-id');
    expect(client.elementSendKeys).toHaveBeenCalledWith('element-id', 'hello');
    expect(client.getElementAttribute).toHaveBeenCalledWith('element-id', 'text');
    expect(client.elementSendKeys).toHaveBeenCalledTimes(1);
  });

  test('native iOS: reads `value` back and treats a placeholder as empty', async () => {
    const attributes: Record<string, string> = { value: 'Search', placeholderValue: 'Search' };
    const client = mockClient({
      isAndroid: false,
      getElementAttribute: vi.fn().mockImplementation((_id, name) => attributes[name]),
    });
    const locator = nativeLocator(client);
    expect(await locator.inputValue()).toBe('');

    attributes.value = 'wiki';
    expect(await locator.inputValue()).toBe('wiki');
  });

  test('web: clears through the DOM and reads the value through the DOM', async () => {
    const client = mockClient({
      executeScript: vi
        .fn()
        .mockImplementation(async (script: string) =>
          script.includes('return') ? 'hello' : undefined,
        ),
    });
    await webLocator(client).fill('hello');

    expect(client.elementClear).not.toHaveBeenCalled();
    const [clearScript, clearArgs] = calls(client.executeScript)[0]!;
    expect(clearScript).toContain("dispatchEvent(new Event('input'");
    expect(clearArgs).toEqual([ELEMENT]);
    expect(client.elementSendKeys).toHaveBeenCalledWith('element-id', 'hello');
    const [valueScript] = calls(client.executeScript)[1]!;
    expect(valueScript).toContain('el.value');
  });

  test('retries once when the readback disagrees, then reports both values', async () => {
    const client = mockClient({ getElementAttribute: textAttr('ello') });
    await expect(nativeLocator(client).fill('hello')).rejects.toThrow(
      'holds "ello" after filling "hello"',
    );
    expect(client.elementClear).toHaveBeenCalledTimes(2);
    expect(client.elementSendKeys).toHaveBeenCalledTimes(2);
  });

  test('a self-healing retry succeeds silently', async () => {
    const client = mockClient({ getElementAttribute: textAttrSequence('ello', 'hello') });
    await nativeLocator(client).fill('hello');
    expect(client.elementSendKeys).toHaveBeenCalledTimes(2);
  });

  test('secret: compares lengths and never prints the value', async () => {
    const client = mockClient({ getElementAttribute: textAttr('••••') });
    await nativeLocator(client).fill('pass', { secret: true });
    expect(client.elementSendKeys).toHaveBeenCalledTimes(1);

    const short = mockClient({ getElementAttribute: textAttr('•••') });
    const error = await nativeLocator(short)
      .fill('pass', { secret: true })
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('3 character(s) after filling 4 character(s)');
    expect((error as Error).message).not.toContain('pass');
  });

  test('a masked readback of the right length counts as a match without secret', async () => {
    const client = mockClient({ getElementAttribute: textAttr('●●●●') });
    await nativeLocator(client).fill('pass');
    expect(client.elementSendKeys).toHaveBeenCalledTimes(1);
  });

  test('throws when the element is not visible', async () => {
    const client = mockClient({ findElements: vi.fn().mockResolvedValue([]) });
    await expect(nativeLocator(client).fill('x', { timeout: 1_000 })).rejects.toThrow(
      'Failed to fill: Element "//field" not visible',
    );
    expect(client.elementSendKeys).not.toHaveBeenCalled();
  });
});

describe('clear / press / inputValue', () => {
  test('clear on a native element uses elementClear', async () => {
    const client = mockClient();
    await nativeLocator(client).clear();
    expect(client.elementClear).toHaveBeenCalledWith('element-id');
    expect(client.executeScript).not.toHaveBeenCalled();
  });

  test('clear on a web element goes through the DOM', async () => {
    const client = mockClient();
    await webLocator(client).clear();
    expect(client.elementClear).not.toHaveBeenCalled();
    expect(client.executeScript).toHaveBeenCalledTimes(1);
  });

  test('press never clears and maps named keys', async () => {
    const client = mockClient();
    const locator = nativeLocator(client);
    await locator.press('Enter');
    await locator.press('Tab');
    await locator.press('a');
    expect(client.elementClear).not.toHaveBeenCalled();
    expect(calls(client.elementSendKeys).map((c) => c[1])).toEqual(['\n', '\t', 'a']);
  });

  test('inputValue on Android reads the text attribute and treats the hint as empty', async () => {
    const attributes: Record<string, string> = {
      text: 'Search Wikipedia',
      hint: 'Search Wikipedia',
    };
    const client = mockClient({
      getElementAttribute: vi.fn().mockImplementation((_id, name) => attributes[name]),
    });
    const locator = nativeLocator(client);
    expect(await locator.inputValue()).toBe('');
    expect(client.getElementAttribute).toHaveBeenCalledWith('element-id', 'text');
    expect(client.getElementAttribute).toHaveBeenCalledWith('element-id', 'hint');

    attributes.text = 'typed';
    expect(await locator.inputValue()).toBe('typed');
  });
});
