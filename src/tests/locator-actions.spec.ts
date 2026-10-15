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

/** A DOM element as the WebView enabled-state script sees it. */
type FakeNode = {
  nodeType: 1;
  tagName: string;
  isContentEditable: boolean;
  parentElement: FakeNode | null;
  getAttribute: (name: string) => string | null;
  matches: (selector: string) => boolean;
  closest: (selector: string) => FakeNode | null;
};

const BUTTON_LIKE_ROLES = ['button', 'checkbox', 'radio'];

/**
 * `disabled` stands for the browser's own `:disabled` match, so a control inside a disabled
 * fieldset is built with `disabled: true` the way the browser would report it. `closest` only
 * understands the button-like selector the script uses.
 */
function domNode(
  tagName: string,
  { attrs = {}, disabled = false }: { attrs?: Record<string, string>; disabled?: boolean } = {},
  parentElement: FakeNode | null = null,
): FakeNode {
  const node: FakeNode = {
    nodeType: 1,
    tagName,
    isContentEditable: attrs.contenteditable === 'true',
    parentElement,
    getAttribute: (name) => attrs[name] ?? null,
    matches: (selector) => selector === ':disabled' && disabled,
    closest: () => {
      for (let n: FakeNode | null = node; n; n = n.parentElement) {
        if (n.tagName === 'BUTTON' || BUTTON_LIKE_ROLES.includes(n.getAttribute('role') ?? '')) {
          return n;
        }
      }
      return null;
    },
  };
  return node;
}

/** Runs the scripts the locator sends against `node`, the element the locator resolved to. */
const runScriptOn = (node: FakeNode) =>
  vi.fn().mockImplementation(async (script: string) => new Function(script).call(null, node));

/** A WebDriver error the way the `webdriver` client names it. */
function driverError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('tap actionability', () => {
  test('waits for a button that becomes enabled, then clicks once', async () => {
    const client = mockClient({
      isElementEnabled: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    });
    await nativeLocator(client).tap({ timeout: 2_000 });
    expect(client.isElementEnabled).toHaveBeenCalledTimes(2);
    expect(calls(client.elementClick)).toEqual([['element-id']]);
  });

  test('an element that stays disabled fails saying so, with the force hint, without clicking', async () => {
    const client = mockClient({ isElementEnabled: vi.fn().mockResolvedValue(false) });
    await expect(nativeLocator(client).tap({ timeout: 1_000 })).rejects.toThrow(
      'Failed to tap: Element "//field" is visible but disabled after 1000ms. ' +
        'Pass { force: true } to tap anyway.',
    );
    expect(client.elementClick).not.toHaveBeenCalled();
  });

  test('a hidden element fails as not visible, without reading the enabled state', async () => {
    const client = mockClient({
      isElementDisplayed: vi.fn().mockResolvedValue(false),
      isElementEnabled: vi.fn().mockResolvedValue(true),
    });
    await expect(nativeLocator(client).tap({ timeout: 1_000 })).rejects.toThrow(
      'Failed to tap: Element "//field" not visible after 1000ms',
    );
    expect(client.isElementEnabled).not.toHaveBeenCalled();
  });

  test('a selector that matches nothing says so', async () => {
    const client = mockClient({ findElements: vi.fn().mockResolvedValue([]) });
    await expect(nativeLocator(client).tap({ timeout: 1_000 })).rejects.toThrow(
      'Failed to tap: Element "//field" not visible after 1000ms: nothing matches the selector',
    );
  });

  test('force taps a hidden, disabled element as soon as it exists', async () => {
    const client = mockClient({
      isElementDisplayed: vi.fn().mockResolvedValue(false),
      isElementEnabled: vi.fn().mockResolvedValue(false),
    });
    await nativeLocator(client).tap({ force: true });
    expect(calls(client.elementClick)).toEqual([['element-id']]);
    expect(client.isElementDisplayed).not.toHaveBeenCalled();
    expect(client.isElementEnabled).not.toHaveBeenCalled();
  });

  test('force still waits for the element to exist', async () => {
    const client = mockClient({ findElements: vi.fn().mockResolvedValue([]) });
    await expect(nativeLocator(client).tap({ force: true, timeout: 1_000 })).rejects.toThrow(
      'Failed to tap: Element "//field" not found after 1000ms',
    );
  });

  test('trial runs the checks without tapping', async () => {
    const enabled = mockClient({ isElementEnabled: vi.fn().mockResolvedValue(true) });
    await nativeLocator(enabled).tap({ trial: true });
    expect(enabled.isElementEnabled).toHaveBeenCalled();
    expect(enabled.elementClick).not.toHaveBeenCalled();

    const disabled = mockClient({ isElementEnabled: vi.fn().mockResolvedValue(false) });
    await expect(nativeLocator(disabled).tap({ trial: true, timeout: 1_000 })).rejects.toThrow(
      'is visible but disabled',
    );
    expect(disabled.elementClick).not.toHaveBeenCalled();
  });

  test.each(['element click intercepted', 'stale element reference', 'element not interactable'])(
    'a "%s" click re-runs the checks and taps again',
    async (name) => {
      const client = mockClient({
        isElementEnabled: vi.fn().mockResolvedValue(true),
        elementClick: vi.fn().mockRejectedValueOnce(driverError(name)).mockResolvedValue(undefined),
      });
      await nativeLocator(client).tap({ timeout: 2_000 });
      expect(client.elementClick).toHaveBeenCalledTimes(2);
      expect(client.findElements).toHaveBeenCalledTimes(2);
    },
  );

  test('a click that stays intercepted reports the driver error at the timeout', async () => {
    const client = mockClient({
      isElementEnabled: vi.fn().mockResolvedValue(true),
      elementClick: vi
        .fn()
        .mockRejectedValue(
          driverError('element click intercepted', 'Other element would receive the click'),
        ),
    });
    await expect(nativeLocator(client).tap({ timeout: 1_000 })).rejects.toThrow(
      'Failed to tap: Element "//field" could not be used after 1000ms: ' +
        'Other element would receive the click',
    );
  });

  test('an element that keeps going stale says so at the timeout', async () => {
    const client = mockClient({
      isElementDisplayed: vi.fn().mockRejectedValue(driverError('stale element reference')),
    });
    await expect(nativeLocator(client).tap({ timeout: 1_000 })).rejects.toThrow(
      'Failed to tap: Element "//field" could not be used after 1000ms: Stale element detected',
    );
  });

  test('any other click error is thrown at once', async () => {
    const client = mockClient({
      isElementEnabled: vi.fn().mockResolvedValue(true),
      elementClick: vi.fn().mockRejectedValue(new Error('session deleted')),
    });
    await expect(nativeLocator(client).tap({ timeout: 5_000 })).rejects.toThrow('session deleted');
    expect(client.elementClick).toHaveBeenCalledTimes(1);
  });

  test('acts on the element it checked, without finding it again', async () => {
    const client = mockClient({ getElementAttribute: textAttr('x') });
    await nativeLocator(client).fill('x');
    expect(client.findElements).toHaveBeenCalledTimes(1);
  });
});

describe('enabled state', () => {
  test('native: reads WebDriver enabled, never a DOM script', async () => {
    const client = mockClient({ isElementEnabled: vi.fn().mockResolvedValue(false) });
    expect(await nativeLocator(client).isEnabled()).toBe(false);
    expect(client.isElementEnabled).toHaveBeenCalledWith('element-id');
    expect(client.executeScript).not.toHaveBeenCalled();
  });

  test('web: aria-disabled="true" on the button disables the text inside it', async () => {
    const button = domNode('BUTTON', { attrs: { 'aria-disabled': 'true' } });
    const client = mockClient({
      executeScript: runScriptOn(domNode('SPAN', {}, button)),
      isElementEnabled: vi.fn().mockResolvedValue(true),
    });
    const locator = webLocator(client);
    expect(await locator.isEnabled()).toBe(false);
    await expect(locator.tap({ timeout: 1_000 })).rejects.toThrow('is visible but disabled');
    expect(client.elementClick).not.toHaveBeenCalled();
    expect(client.isElementEnabled).not.toHaveBeenCalled();
    expect(calls(client.executeScript)[0]![1]).toEqual([ELEMENT]);
  });

  test('web: follows Playwright: retarget to the button, native :disabled, nearest aria-disabled', async () => {
    const isEnabledIn = (node: FakeNode) =>
      webLocator(mockClient({ executeScript: runScriptOn(node) })).isEnabled();

    // Text inside a disabled button reads the button.
    expect(await isEnabledIn(domNode('SPAN', {}, domNode('BUTTON', { disabled: true })))).toBe(
      false,
    );
    expect(await isEnabledIn(domNode('SPAN', {}, domNode('BUTTON')))).toBe(true);
    // A role=button counts as a button.
    const roleButton = domNode('DIV', { attrs: { role: 'button', 'aria-disabled': 'true' } });
    expect(await isEnabledIn(domNode('SPAN', {}, roleButton))).toBe(false);
    // A disabled form field.
    expect(await isEnabledIn(domNode('INPUT', { disabled: true }))).toBe(false);
    // The nearest aria-disabled wins.
    const off = domNode('DIV', { attrs: { 'aria-disabled': 'true' } });
    expect(await isEnabledIn(domNode('BUTTON', { attrs: { 'aria-disabled': 'false' } }, off))).toBe(
      true,
    );
    // A disabled fieldset only disables the controls inside it, not its text.
    expect(await isEnabledIn(domNode('P', {}, domNode('FIELDSET', { disabled: true })))).toBe(true);
  });

  test("waitFor('enabled') names the disabled state; 'disabled' resolves on it", async () => {
    const client = mockClient({ isElementEnabled: vi.fn().mockResolvedValue(false) });
    const locator = nativeLocator(client);
    const error = await locator.waitFor('enabled', { timeout: 1_000 }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toBe('Element "//field" is visible but disabled after 1000ms');
    await locator.waitFor('disabled');
  });

  test("waitFor('enabled') on a missing element says it did not become visible", async () => {
    const client = mockClient({ findElements: vi.fn().mockResolvedValue([]) });
    await expect(nativeLocator(client).waitFor('enabled', { timeout: 1_000 })).rejects.toThrow(
      'Element "//field" did not become visible after 1000ms',
    );
  });

  test("waitFor('visible') and fill do not read the enabled state", async () => {
    const client = mockClient({
      isElementEnabled: vi.fn().mockResolvedValue(false),
      getElementAttribute: textAttr('x'),
    });
    const locator = nativeLocator(client);
    await locator.waitFor('visible');
    await locator.fill('x');
    expect(client.isElementEnabled).not.toHaveBeenCalled();
  });
});

describe('polling', () => {
  test('polls at once, then after 100, 250 and 500 ms, and a last time at the deadline', async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      const at: number[] = [];
      const client = mockClient({
        findElements: vi.fn().mockImplementation(async () => {
          at.push(Date.now() - start);
          return [];
        }),
      });
      const done = nativeLocator(client)
        .waitFor('visible', { timeout: 1_000 })
        .catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await done).toBeInstanceOf(TimeoutError);
      expect(at).toEqual([0, 100, 350, 850, 1_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a driver error that persists is thrown in place of the timeout', async () => {
    const client = mockClient({
      findElements: vi.fn().mockRejectedValue(new Error('chromedriver disconnected')),
    });
    await expect(nativeLocator(client).waitFor('visible', { timeout: 1_000 })).rejects.toThrow(
      'chromedriver disconnected',
    );
  });
});
