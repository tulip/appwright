import retry from 'async-retry';
// @ts-ignore ts not able to identify the import is just an interface
import { Client as WebDriverClient } from 'webdriver';

import {
  ActionOptions,
  ELEMENT_REFERENCE_ID,
  ElementReference,
  FillOptions,
  ScrollDirection,
  TimeoutOptions,
  WebDriverErrors,
} from '../types';
import { NonRetryableError, RetryableError, TimeoutError } from '../types/errors';
import { boxedStep, isNoSuchWindowError } from '../utils';

/**
 * Empties an `<input>`/`<textarea>` the way React notices. chromedriver's `elementClear` fires
 * only `change`, and a controlled input whose owner never saw the edit keeps its old state.
 * Setting the value through the prototype setter and dispatching `input` is what React's change
 * tracker listens for, so the owner's `onChange('')` runs before the typing.
 */
const WEB_CLEAR_SCRIPT = `
  var el = arguments[0];
  var proto = Object.getPrototypeOf(el);
  var descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
  if (descriptor && descriptor.set) { descriptor.set.call(el, ''); } else { el.value = ''; }
  el.dispatchEvent(new Event('input', { bubbles: true }));
`;

const WEB_VALUE_SCRIPT =
  'var el = arguments[0]; return el && el.value != null ? String(el.value) : "";';

/**
 * Whether a DOM element is enabled: neither it nor an ancestor is `:disabled` or
 * `aria-disabled="true"`. Ancestors count because text locators resolve to the innermost match,
 * which is often a `<span>` inside the `<button>` that carries the state. A `<fieldset>` is
 * skipped as an ancestor: the controls inside a disabled one match `:disabled` themselves.
 */
const WEB_ENABLED_SCRIPT = `
  for (var n = arguments[0]; n && n.nodeType === 1; n = n.parentElement) {
    if (n.getAttribute('aria-disabled') === 'true') { return false; }
    if (n.tagName !== 'FIELDSET' && n.matches && n.matches(':disabled')) { return false; }
  }
  return true;
`;

/** Named keys `press()` understands; anything else is sent as typed. */
const KEY_MAP: Record<string, string> = {
  Enter: '\n',
  Tab: '\t',
};

/**
 * Android key codes for the named keys. On a native Android field `elementSendKeys` is
 * UiAutomator2's `setText`, which *replaces* the text even with `replace: false` — a `"\n"` leaves
 * the field holding a single space and presses nothing. A key event is the only real key press.
 */
const ANDROID_KEYCODES: Record<string, number> = {
  Enter: 66,
  Tab: 61,
};

type ElementState = 'attached' | 'visible' | 'hidden' | 'enabled' | 'disabled';

/** What the last poll of `waitForState` saw, used to word the timeout. */
type ObservedState = 'detached' | 'hidden' | 'visible' | 'enabled' | 'disabled';

export class Locator {
  constructor(
    private webDriverClient: WebDriverClient,
    private timeoutOpts: TimeoutOptions,
    // Used for find elements request that is sent to Appium server
    private selector: string,
    private findStrategy: string,
    // Used to filter elements received from Appium server
    private textToMatch?: string | RegExp,
    /**
     * Whether this locator resolves inside a WEBVIEW context. Clearing and reading an input
     * differ between chromedriver (DOM) and the native drivers (element attributes).
     */
    private isWeb: boolean = false,
  ) {}

  /**
   * Replaces the element's contents with `value`: clear, type, then read the value back. iOS
   * drops leading characters when a field takes focus mid-send, so a mismatch is retried once
   * before it is reported. Pass `verify: false` for fields that legitimately change what was
   * typed (input masks, auto-formatting, `maxLength`, autocorrect).
   *
   * Only a native iOS field is tapped first: XCUITest refuses keys to a field that never raised
   * the keyboard. UiAutomator2 and the WebView drivers set the value without focus, so on Android
   * `fill` does not raise the software keyboard.
   */
  @boxedStep
  async fill(value: string, options?: FillOptions): Promise<void> {
    const secret = options?.secret === true;
    const verify = options?.verify !== false;
    const actionOptions = this.toActionOptions(options);
    const elementId = await this.requireVisibleElementId('fill', actionOptions);

    if (!this.isWeb && !this.webDriverClient.isAndroid) {
      await this.webDriverClient.elementClick(elementId);
    }

    if (!verify) {
      await this.clearElement(elementId);
      await this.webDriverClient.elementSendKeys(elementId, value);
      return;
    }

    let entered = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await this.clearElement(elementId);
      await this.webDriverClient.elementSendKeys(elementId, value);

      entered = await this.readValue(elementId);
      if (Locator.valueMatches(entered, value, secret)) {
        return;
      }
    }

    const got = secret ? `${entered.length} character(s)` : JSON.stringify(entered);
    const expected = secret ? `${value.length} character(s)` : JSON.stringify(value);
    throw new Error(
      `Failed to fill: Element "${this.selector}" holds ${got} after filling ${expected}. ` +
        'If the field reformats what is typed (input mask, maxLength, autocorrect), pass ' +
        '`{ verify: false }` and assert with inputValue() instead.',
    );
  }

  @boxedStep
  async clear(options?: ActionOptions): Promise<void> {
    const elementId = await this.requireVisibleElementId('clear', options);
    await this.clearElement(elementId);
  }

  @boxedStep
  async press(key: string, options?: ActionOptions): Promise<void> {
    const elementId = await this.requireVisibleElementId('press', options);

    if (this.isWeb || !this.webDriverClient.isAndroid) {
      // chromedriver and XCUITest both type a "\n" as the Return key without touching the value.
      await this.webDriverClient.elementSendKeys(elementId, KEY_MAP[key] ?? key);
      return;
    }

    // Native Android: send key events to the focused field instead of setText (see
    // ANDROID_KEYCODES). Tapping first puts focus on this element; it does not change the text.
    await this.webDriverClient.elementClick(elementId);
    const keycode = ANDROID_KEYCODES[key];
    if (keycode != null) {
      await this.webDriverClient.executeScript('mobile: pressKey', [{ keycode }]);
      return;
    }
    await this.webDriverClient.performActions([
      {
        type: 'key',
        id: 'keyboard',
        actions: key.split('').flatMap((char) => [
          { type: 'keyDown', value: char },
          { type: 'keyUp', value: char },
        ]),
      },
    ]);
    await this.webDriverClient.releaseActions();
  }

  @boxedStep
  async inputValue(options?: ActionOptions): Promise<string> {
    const elementId = await this.requireVisibleElementId('inputValue', options);
    return await this.readValue(elementId);
  }

  @boxedStep
  async sendKeyStrokes(value: string, options?: ActionOptions): Promise<void> {
    const elementId = await this.requireVisibleElementId('sendKeyStrokes', options);
    await this.webDriverClient.elementClick(elementId);
    const actions = value
      .split('')
      .map((char) => [
        { type: 'keyDown', value: char },
        { type: 'keyUp', value: char },
      ])
      .flat();

    await this.webDriverClient.performActions([
      {
        type: 'key',
        id: 'keyboard',
        actions: actions,
      },
    ]);

    await this.webDriverClient.releaseActions();
  }

  async isVisible(options?: ActionOptions): Promise<boolean> {
    try {
      await this.waitFor('visible', options);
      return true;
    } catch (err) {
      if (err instanceof TimeoutError) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Waits for the element to be visible, then returns whether it is enabled right now. Throws
   * when the element does not become visible within the timeout.
   */
  async isEnabled(options?: ActionOptions): Promise<boolean> {
    const elementId = await this.requireVisibleElementId('isEnabled', options);
    return await this.readEnabled(elementId);
  }

  async waitFor(state: ElementState, options?: ActionOptions): Promise<void> {
    const timeout = this.resolveTimeout(options);
    const observed = await this.waitForState(state, timeout);
    if (observed !== null) {
      throw new TimeoutError(
        `Element "${this.selector}" ${Locator.describeTimeout(state, observed)} after ${timeout}ms`,
      );
    }
  }

  /**
   * Polls until the element reaches `state`. Resolves `null` once it does, or what the last poll
   * saw when the timeout runs out. `'enabled'` and `'disabled'` both require the element to be
   * visible.
   */
  private async waitForState(state: ElementState, timeout: number): Promise<ObservedState | null> {
    let observed = 'detached' as ObservedState;
    try {
      await this.waitUntil(async () => {
        const element = await this.getElement();
        const elementId = element?.[ELEMENT_REFERENCE_ID];

        if (!elementId) {
          // Nothing matches: that is exactly 'hidden', and no other state.
          observed = 'detached';
          return state === 'hidden';
        }

        if (state === 'attached') {
          return true;
        }

        const isDisplayed = await this.retryIfStale(() =>
          this.webDriverClient.isElementDisplayed(elementId),
        );
        observed = isDisplayed ? 'visible' : 'hidden';
        if (state === 'hidden') {
          return !isDisplayed;
        }
        if (!isDisplayed || state === 'visible') {
          return isDisplayed;
        }

        const isEnabled = await this.retryIfStale(() => this.readEnabled(elementId));
        observed = isEnabled ? 'enabled' : 'disabled';
        return state === 'enabled' ? isEnabled : !isEnabled;
      }, timeout);
      return null;
    } catch (error) {
      if (error instanceof TimeoutError) {
        return observed;
      }
      throw error;
    }
  }

  private static describeTimeout(state: ElementState, observed: ObservedState): string {
    if (state === 'hidden') {
      return 'was still on the screen';
    }
    if (state === 'enabled' || state === 'disabled') {
      if (observed === 'disabled') {
        return 'is visible but disabled';
      }
      if (observed === 'enabled') {
        return 'is visible but still enabled';
      }
      return 'did not become visible';
    }
    return `did not become ${state}`;
  }

  /**
   * A stale node is being re-rendered, not gone: re-find on the next tick for every state, so a
   * transient stale read never counts as "hidden" or "disabled".
   */
  private async retryIfStale<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      //@ts-ignore
      const errName = error.name;
      if (errName && errName.includes(WebDriverErrors.StaleElementReferenceError)) {
        throw new RetryableError(`Stale element detected: ${error}`);
      }
      throw error;
    }
  }

  /**
   * Native elements report through WebDriver's `enabled`; DOM elements also count
   * `aria-disabled` and disabled ancestors (see WEB_ENABLED_SCRIPT).
   */
  private async readEnabled(elementId: string): Promise<boolean> {
    if (this.isWeb) {
      const enabled = await this.webDriverClient.executeScript(WEB_ENABLED_SCRIPT, [
        { [ELEMENT_REFERENCE_ID]: elementId },
      ]);
      return enabled !== false;
    }
    return await this.webDriverClient.isElementEnabled(elementId);
  }

  private async waitUntil<ReturnValue>(
    condition: () => ReturnValue | Promise<ReturnValue>,
    timeout: number,
  ): Promise<Exclude<ReturnValue, boolean>> {
    const fn = condition.bind(this.webDriverClient);
    try {
      return await retry(
        async () => {
          try {
            const result = await fn();
            if (result === false) {
              throw new RetryableError(`condition returned false`);
            }
            return result as Exclude<ReturnValue, boolean>;
          } catch (error) {
            if (isNoSuchWindowError(error)) {
              throw new NonRetryableError(
                error instanceof Error ? error.message : String(error),
                'NoSuchWindowError',
              );
            }
            throw error;
          }
        },
        {
          maxRetryTime: timeout,
          retries: Math.ceil(timeout / 1000),
          factor: 1,
        },
      );
    } catch (err: unknown) {
      if (err instanceof RetryableError) {
        // Last attempt failed, no longer retryable
        throw new TimeoutError(`waitUntil condition timed out after ${timeout}ms`);
      } else {
        throw err;
      }
    }
  }

  @boxedStep
  async tap(options?: ActionOptions) {
    const elementId = await this.requireEnabledElementId('tap', options);
    await this.webDriverClient.elementClick(elementId);
  }

  @boxedStep
  async getText(options?: ActionOptions): Promise<string> {
    const elementId = await this.requireVisibleElementId('getText', options);
    return await this.webDriverClient.getElementText(elementId);
  }

  @boxedStep
  async scroll(direction: ScrollDirection) {
    const element = await this.getElement();
    if (!element) {
      throw new Error(`Failed to scroll: Element "${this.selector}" not found`);
    }
    if (this.webDriverClient.isAndroid) {
      await this.webDriverClient.executeScript('mobile: scrollGesture', [
        {
          elementId: element[ELEMENT_REFERENCE_ID],
          direction: direction,
          percent: 1,
        },
      ]);
    } else {
      await this.webDriverClient.executeScript('mobile: scroll', [
        {
          elementId: element[ELEMENT_REFERENCE_ID],
          direction: direction,
        },
      ]);
    }
  }

  /**
   * Retrieves the element reference based on the `selector`.
   *
   * @returns
   */
  async getElement(): Promise<ElementReference | null> {
    /**
     * Determine whether `path` is a regex or string, and find elements accordingly.
     *
     * If `path` is a regex:
     * - Iterate through all the elements on the page
     * - Extract text content of each element
     * - Return the first matching element
     *
     * If `path` is a string:
     * - Use `findStrategy` (either XPath, Android UIAutomator, or iOS predicate string) to find elements
     * - Apply regex to clean extra characters from the matched element’s text
     * - Return the first element that matches
     */
    let elements: ElementReference[] = await this.webDriverClient.findElements(
      this.findStrategy,
      this.selector,
    );
    // If there is only one element, return it
    if (elements.length === 1) {
      return elements[0]!;
    }
    // If there are multiple elements, we reverse the order since the probability
    // of finding the element is higher at higher depth
    const reversedElements = elements.reverse();
    for (const element of reversedElements) {
      let elementText = await this.webDriverClient.getElementText(element[ELEMENT_REFERENCE_ID]);
      if (this.textToMatch) {
        if (this.textToMatch instanceof RegExp && this.textToMatch.test(elementText)) {
          return element;
        }
        if (typeof this.textToMatch === 'string' && elementText.includes(this.textToMatch!)) {
          return element;
        }
      } else {
        // This is returned for cases where xpath is findStrategy and we want
        // to return the last element found in the list
        return element;
      }
    }
    return null;
  }

  /**
   * Waits for the element to be visible and returns its reference id, or throws with the
   * action's name so the failure reads as "Failed to fill: …" rather than a bare timeout.
   */
  private async requireVisibleElementId(action: string, options?: ActionOptions): Promise<string> {
    const isElementDisplayed = await this.isVisible(options);
    if (!isElementDisplayed) {
      throw new Error(`Failed to ${action}: Element "${this.selector}" not visible`);
    }
    return await this.findElementId(action);
  }

  /**
   * Like `requireVisibleElementId`, but also waits for the element to be enabled within the same
   * timeout. A disabled control accepts a click and ignores it, so tapping one early fails much
   * later and somewhere else; this fails here instead, saying the element is disabled.
   */
  private async requireEnabledElementId(action: string, options?: ActionOptions): Promise<string> {
    const timeout = this.resolveTimeout(options);
    const observed = await this.waitForState('enabled', timeout);
    if (observed === 'disabled') {
      throw new Error(
        `Failed to ${action}: Element "${this.selector}" is visible but disabled after ${timeout}ms`,
      );
    }
    if (observed !== null) {
      throw new Error(`Failed to ${action}: Element "${this.selector}" not visible`);
    }
    return await this.findElementId(action);
  }

  private async findElementId(action: string): Promise<string> {
    const element = await this.getElement();
    const elementId = element?.[ELEMENT_REFERENCE_ID];
    if (!elementId) {
      throw new Error(`Failed to ${action}: Element "${this.selector}" is not found`);
    }
    return elementId;
  }

  private resolveTimeout(options?: ActionOptions): number {
    return options?.timeout || this.timeoutOpts.expectTimeout;
  }

  private async clearElement(elementId: string): Promise<void> {
    if (this.isWeb) {
      await this.webDriverClient.executeScript(WEB_CLEAR_SCRIPT, [
        { [ELEMENT_REFERENCE_ID]: elementId },
      ]);
      return;
    }
    await this.webDriverClient.elementClear(elementId);
  }

  private async readValue(elementId: string): Promise<string> {
    if (this.isWeb) {
      const value = await this.webDriverClient.executeScript(WEB_VALUE_SCRIPT, [
        { [ELEMENT_REFERENCE_ID]: elementId },
      ]);
      return value == null ? '' : String(value);
    }
    if (this.webDriverClient.isAndroid) {
      // uiautomator2 exposes an EditText's contents as `text` — and reports the hint there while
      // the field is empty, so an empty field has to be recognised through `hint`.
      const text = await this.webDriverClient.getElementAttribute(elementId, 'text');
      if (text == null || text === '') {
        return '';
      }
      const hint = await this.webDriverClient.getElementAttribute(elementId, 'hint');
      return hint != null && hint === text ? '' : String(text);
    }
    // XCUITest exposes a field's contents as `value` — and reports the placeholder there while
    // the field is empty, so an empty field has to be recognised through `placeholderValue`.
    const value = await this.webDriverClient.getElementAttribute(elementId, 'value');
    if (value == null || value === '') {
      return '';
    }
    const placeholder = await this.webDriverClient.getElementAttribute(
      elementId,
      'placeholderValue',
    );
    return placeholder != null && placeholder === value ? '' : String(value);
  }

  /**
   * Whether a readback proves the field holds `value`. Secure fields report their contents as
   * bullets on both drivers, so a same-length run of mask characters counts as a match too;
   * with `secret`, only the lengths are compared.
   */
  private static valueMatches(entered: string, value: string, secret: boolean): boolean {
    if (entered === value) {
      return true;
    }
    if (entered.length !== value.length) {
      return false;
    }
    return secret || /^[•●*·]+$/.test(entered);
  }

  private toActionOptions(options?: Partial<ActionOptions>): ActionOptions | undefined {
    return options?.timeout != null ? { timeout: options.timeout } : undefined;
  }
}
