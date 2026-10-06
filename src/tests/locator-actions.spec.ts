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

describe('timeout: 0', () => {
  test('isVisible makes exactly one attempt instead of waiting expectTimeout', async () => {
    const client = mockClient({ findElements: vi.fn().mockResolvedValue([]) });
    const locator = new Locator(client, { expectTimeout: 20_000 }, '//field', 'xpath');
    expect(await locator.isVisible({ timeout: 0 })).toBe(false);
    expect(client.findElements).toHaveBeenCalledTimes(1);
  });

  test("waitFor('hidden') checks once, then times out", async () => {
    const client = mockClient();
    await expect(nativeLocator(client).waitFor('hidden', { timeout: 0 })).rejects.toThrow(
      'Element "//field" was still on the screen after 0ms',
    );
    expect(client.findElements).toHaveBeenCalledTimes(1);
    expect(client.isElementDisplayed).toHaveBeenCalledTimes(1);
  });
});

describe('one lookup per action', () => {
  test('acts on the element the visibility wait found', async () => {
    const client = mockClient({
      getElementRect: vi.fn().mockResolvedValue({ x: 0, y: 0, width: 1, height: 1 }),
    });
    const locator = nativeLocator(client);
    await locator.tap();
    expect(client.findElements).toHaveBeenCalledTimes(1);
    expect(client.elementClick).toHaveBeenCalledWith('element-id');

    await locator.boundingBox();
    expect(client.findElements).toHaveBeenCalledTimes(2);
  });

  test('a chained locator looks its parent up once too', async () => {
    const client = mockClient({
      findElementsFromElement: vi.fn().mockResolvedValue([{ [ELEMENT_REFERENCE_ID]: 'child' }]),
    });
    await nativeLocator(client).getByText('Save').tap();
    expect(client.findElements).toHaveBeenCalledTimes(1);
    expect(client.findElementsFromElement).toHaveBeenCalledTimes(1);
    expect(client.elementClick).toHaveBeenCalledWith('child');
  });
});

describe('fill', () => {
  test('native Android: clears, types, reads back — without tapping, so no keyboard', async () => {
    const client = mockClient({
      getElementAttribute: vi
        .fn()
        .mockImplementation((_id, name) => (name === 'text' ? 'hello' : 'Search…')),
    });
    await nativeLocator(client).fill('hello');

    expect(client.elementClick).not.toHaveBeenCalled();
    expect(client.elementClear).toHaveBeenCalledWith('element-id');
    expect(client.elementSendKeys).toHaveBeenCalledWith('element-id', 'hello');
    expect(client.getElementAttribute).toHaveBeenCalledWith('element-id', 'text');
    expect(client.elementSendKeys).toHaveBeenCalledTimes(1);
  });

  test('native iOS: taps the field first, because XCUITest needs the keyboard up', async () => {
    const client = mockClient({
      isAndroid: false,
      getElementAttribute: vi
        .fn()
        .mockImplementation(async (_id, name) => (name === 'value' ? 'hello' : 'placeholder')),
    });
    await nativeLocator(client).fill('hello');
    expect(client.elementClick).toHaveBeenCalledWith('element-id');
    expect(calls(client.elementClick).length).toBe(1);
  });

  test('web: never taps', async () => {
    const client = mockClient({
      executeScript: vi
        .fn()
        .mockImplementation(async (script: string) =>
          script.includes('return') ? 'hello' : undefined,
        ),
    });
    await webLocator(client).fill('hello');
    expect(client.elementClick).not.toHaveBeenCalled();
  });

  test('verify: false clears and types once, with no readback and no throw', async () => {
    const client = mockClient({ getElementAttribute: textAttr('(555) 123-4567') });
    await nativeLocator(client).fill('5551234567', { verify: false });
    expect(client.elementClear).toHaveBeenCalledTimes(1);
    expect(client.elementSendKeys).toHaveBeenCalledTimes(1);
    expect(client.getElementAttribute).not.toHaveBeenCalled();
  });

  test('a mismatch error points at verify: false', async () => {
    const client = mockClient({ getElementAttribute: textAttr('(555) 123-4567') });
    await expect(nativeLocator(client).fill('5551234567')).rejects.toThrow('{ verify: false }');
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
    await nativeLocator(client).fill('x9Qz', { secret: true });
    expect(client.elementSendKeys).toHaveBeenCalledTimes(1);

    const short = mockClient({ getElementAttribute: textAttr('•••') });
    const error = await nativeLocator(short)
      .fill('x9Qz', { secret: true })
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('3 character(s) after filling 4 character(s)');
    expect((error as Error).message).not.toContain('x9Qz');
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

  test('press on native Android sends real key events and never clears', async () => {
    const client = mockClient({
      performActions: vi.fn().mockResolvedValue(undefined),
      releaseActions: vi.fn().mockResolvedValue(undefined),
    });
    const locator = nativeLocator(client);
    await locator.press('Enter');
    await locator.press('Tab');
    await locator.press('ab');

    expect(client.elementClear).not.toHaveBeenCalled();
    expect(client.elementSendKeys).not.toHaveBeenCalled();
    expect(client.elementClick).toHaveBeenCalledTimes(3);
    expect(calls(client.executeScript)).toEqual([
      ['mobile: pressKey', [{ keycode: 66 }]],
      ['mobile: pressKey', [{ keycode: 61 }]],
    ]);
    const [[actions]] = calls(client.performActions) as [[{ actions: unknown[] }[]]];
    expect(actions[0]!.actions).toEqual([
      { type: 'keyDown', value: 'a' },
      { type: 'keyUp', value: 'a' },
      { type: 'keyDown', value: 'b' },
      { type: 'keyUp', value: 'b' },
    ]);
  });

  test('press on iOS and in a WebView types the mapped character', async () => {
    const ios = mockClient({ isAndroid: false });
    await nativeLocator(ios).press('Enter');
    expect(calls(ios.elementSendKeys)).toEqual([['element-id', '\n']]);
    expect(ios.executeScript).not.toHaveBeenCalled();

    const web = mockClient();
    await webLocator(web).press('Tab');
    expect(calls(web.elementSendKeys)).toEqual([['element-id', '\t']]);
    expect(web.elementClear).not.toHaveBeenCalled();
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

describe('boundingBox', () => {
  test("returns the element's rectangle once it is visible", async () => {
    const client = mockClient({
      isElementDisplayed: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      getElementRect: vi.fn().mockResolvedValue({ x: 12, y: 340, width: 378, height: 44 }),
    });
    expect(await nativeLocator(client).boundingBox()).toEqual({
      x: 12,
      y: 340,
      width: 378,
      height: 44,
    });
    expect(client.getElementRect).toHaveBeenCalledWith('element-id');
    // Two polls, and no lookup after the one that saw it displayed.
    expect(client.findElements).toHaveBeenCalledTimes(2);
  });

  test('throws, naming the element, when it never shows', async () => {
    const client = mockClient({
      isElementDisplayed: vi.fn().mockResolvedValue(false),
      getElementRect: vi.fn(),
    });
    await expect(webLocator(client).boundingBox({ timeout: 10 })).rejects.toThrow(
      'Failed to boundingBox: Element "#field" not visible',
    );
    expect(client.getElementRect).not.toHaveBeenCalled();
  });
});
