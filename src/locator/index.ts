// @ts-ignore ts not able to identify the import is just an interface
import { Client as WebDriverClient } from 'webdriver';

import {
  ActionOptions,
  AppwrightLocator,
  AriaRole,
  ELEMENT_REFERENCE_ID,
  ElementReference,
  FillOptions,
  LabelOptions,
  Rect,
  RoleOptions,
  ScrollDirection,
  TapOptions,
  TextOptions,
  TimeoutOptions,
  WebDriverErrors,
} from '../types';
import { NonRetryableError, RetryableError, TimeoutError } from '../types/errors';
import { boxedStep, delay, isNoSuchWindowError } from '../utils';
import {
  LocatorQuery,
  nativeIdQuery,
  nativeLabelQuery,
  nativeTextQuery,
  SCRIPT_FIND_STRATEGY,
  webLabelQuery,
  webRoleQuery,
  webTestIdQuery,
  webTextQuery,
} from './queries';

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
 * Whether a DOM element is enabled, following Playwright's rules. Anything other than a form
 * field is first retargeted to the closest button-like ancestor, because text locators resolve
 * to the innermost match, often a `<span>` inside the `<button>` that carries the state. The
 * target is disabled when it is a natively `:disabled` control (which covers a disabled
 * `<fieldset>` or `<optgroup>`), or when the nearest `aria-disabled` on it or an ancestor is
 * `"true"`.
 */
const WEB_ENABLED_SCRIPT = `
  var el = arguments[0];
  if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.isContentEditable) {
    el = el.closest('button, [role=button], [role=checkbox], [role=radio]') || el;
  }
  if (/^(BUTTON|INPUT|SELECT|TEXTAREA|OPTION|OPTGROUP)$/.test(el.tagName) && el.matches(':disabled')) {
    return false;
  }
  for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
    var aria = n.getAttribute('aria-disabled');
    if (aria === 'true') { return false; }
    if (aria === 'false') { return true; }
  }
  return true;
`;

/**
 * Waits between polls after the first, immediate one; the last value repeats. A poll costs one or
 * more Appium round trips, so this is coarser than Playwright's 0/20/100/100/500 ms.
 */
const POLL_DELAYS_MS = [100, 250, 500, 1000];

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

/**
 * What the last poll saw, used to word a timeout. `'rejected'` means the element passed its checks
 * but the driver refused the action (stale, intercepted, not interactable).
 */
type ObservedState = 'detached' | 'hidden' | 'visible' | 'enabled' | 'disabled' | 'rejected';

/** What an action waits for before it runs: Playwright's actionability checks. */
type Actionability = 'attached' | 'visible' | 'enabled';

type Probe = { observed: ObservedState; reached: boolean; elementId?: string };

/**
 * Locator methods that build another locator rather than act on the element. They are
 * synchronous, so the context-switching proxies of `Device` and `WebView` pass them through.
 */
export const CHAIN_METHODS: ReadonlySet<PropertyKey> = new Set([
  'getByText',
  'getByRole',
  'getByLabel',
  'getByTestId',
]);

export type LocatorOptions = {
  /** For a chained locator: the locator whose element this one is looked up inside. */
  parent?: Locator;
  /** Shown in step titles and errors instead of the selector. */
  description?: string;
  /**
   * Turns a chained child into what the caller gets back: the context-switching proxy of the
   * `Device` or `WebView` that made this locator.
   */
  wrap?: (locator: Locator) => AppwrightLocator;
};

export class Locator {
  private readonly parent?: Locator;
  readonly description?: string;
  private readonly wrap?: (locator: Locator) => AppwrightLocator;

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
    { parent, description, wrap }: LocatorOptions = {},
  ) {
    this.parent = parent;
    this.description = description;
    this.wrap = wrap;
  }

  /** How errors name this locator: its description, else its selector in quotes. */
  private get named(): string {
    return this.description ?? `"${this.selector}"`;
  }

  getByText(text: string | RegExp, options?: TextOptions): AppwrightLocator {
    return this.chain(
      this.isWeb
        ? webTextQuery(text, options)
        : nativeTextQuery(this.webDriverClient.isAndroid, text, options),
    );
  }

  getByRole(role: AriaRole, options?: RoleOptions): AppwrightLocator {
    if (!this.isWeb) {
      throw new Error(
        'getByRole() needs a WebView locator: native views have no ARIA roles. Chain ' +
          'getByText(), getByLabel() or getByTestId() instead.',
      );
    }
    return this.chain(webRoleQuery(role, options));
  }

  getByLabel(label: string, options?: LabelOptions): AppwrightLocator {
    return this.chain(
      this.isWeb
        ? webLabelQuery(label, options)
        : nativeLabelQuery(this.webDriverClient.isAndroid, label, options),
    );
  }

  getByTestId(testId: string): AppwrightLocator {
    return this.chain(
      this.isWeb ? webTestIdQuery(testId) : nativeIdQuery(this.webDriverClient.isAndroid, testId),
    );
  }

  private chain(query: LocatorQuery): AppwrightLocator {
    const parentName = this.description ?? this.selector;
    const child = new Locator(
      this.webDriverClient,
      this.timeoutOpts,
      query.selector,
      query.findStrategy,
      query.textToMatch,
      this.isWeb,
      {
        parent: this,
        description: `${parentName} >> ${query.description ?? query.selector}`,
        wrap: this.wrap,
      },
    );
    return this.wrap ? this.wrap(child) : child;
  }

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
    await this.act('fill', 'visible', options, async (elementId) => {
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
        `Failed to fill: Element ${this.named} holds ${got} after filling ${expected}. ` +
          'If the field reformats what is typed (input mask, maxLength, autocorrect), pass ' +
          '`{ verify: false }` and assert with inputValue() instead.',
      );
    });
  }

  @boxedStep
  async clear(options?: ActionOptions): Promise<void> {
    await this.act('clear', 'visible', options, (elementId) => this.clearElement(elementId));
  }

  @boxedStep
  async press(key: string, options?: ActionOptions): Promise<void> {
    await this.act('press', 'visible', options, async (elementId) => {
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
    });
  }

  @boxedStep
  async inputValue(options?: ActionOptions): Promise<string> {
    return await this.act('inputValue', 'visible', options, (elementId) =>
      this.readValue(elementId),
    );
  }

  @boxedStep
  async sendKeyStrokes(value: string, options?: ActionOptions): Promise<void> {
    await this.act('sendKeyStrokes', 'visible', options, async (elementId) => {
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
    });
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
    return await this.act('isEnabled', 'visible', options, (elementId) =>
      this.readEnabled(elementId),
    );
  }

  async waitFor(state: ElementState, options?: ActionOptions): Promise<void> {
    const timeout = this.resolveTimeout(options);
    const observed = await this.waitForState(state, timeout);
    if (observed !== null) {
      const what = Locator.describeTimeout(state, observed);
      throw new TimeoutError(`Element ${this.named} ${what} after ${timeout}ms`);
    }
  }

  /**
   * Polls until the element reaches `state`. Resolves `null` once it does, or what the last poll
   * saw when the timeout runs out. `'enabled'` and `'disabled'` both require the element to be
   * visible.
   */
  private async waitForState(state: ElementState, timeout: number): Promise<ObservedState | null> {
    let observed: ObservedState = 'detached';
    try {
      await this.waitUntil(async () => {
        const probe = await this.probe(state);
        observed = probe.observed;
        return probe.reached;
      }, timeout);
      return null;
    } catch (error) {
      if (error instanceof TimeoutError) {
        return observed;
      }
      throw error;
    }
  }

  /** One poll: finds the element and reads only as much of its state as `state` needs. */
  private async probe(state: ElementState): Promise<Probe> {
    const element = await this.getElement();
    const elementId = element?.[ELEMENT_REFERENCE_ID];

    if (!elementId) {
      // Nothing matches: that is exactly 'hidden', and no other state.
      return { observed: 'detached', reached: state === 'hidden' };
    }
    if (state === 'attached') {
      return { observed: 'visible', reached: true, elementId };
    }

    const isDisplayed = await this.retryIfStale(() =>
      this.webDriverClient.isElementDisplayed(elementId),
    );
    if (state === 'hidden' || !isDisplayed || state === 'visible') {
      const reached = state === 'hidden' ? !isDisplayed : isDisplayed;
      return { observed: isDisplayed ? 'visible' : 'hidden', reached, elementId };
    }

    const isEnabled = await this.retryIfStale(() => this.readEnabled(elementId));
    return {
      observed: isEnabled ? 'enabled' : 'disabled',
      reached: state === 'enabled' ? isEnabled : !isEnabled,
      elementId,
    };
  }

  /**
   * Runs an action the way Playwright does: polls until the element passes `actionability`, then
   * runs `perform` on that same element. If the driver refuses the action because the element
   * went stale, is covered or is not interactable, the whole check runs again within what is left
   * of the timeout, and a timeout after such a refusal keeps the driver error's `name`. Any other
   * error from `perform` is thrown as is. Without `perform` (a trial) only the checks run.
   */
  private async act<T>(
    action: string,
    actionability: Actionability,
    options: Partial<ActionOptions> | undefined,
    perform?: (elementId: string) => Promise<T>,
  ): Promise<T> {
    const timeout = this.resolveTimeout(options);
    let observed = 'detached' as ObservedState;
    let rejection: unknown;
    let outcome: { value: T } | { error: unknown } | undefined;
    try {
      await this.waitUntil(async () => {
        let probe: Probe;
        try {
          probe = await this.probe(actionability);
        } catch (error) {
          if (error instanceof RetryableError) {
            observed = 'rejected';
            rejection = error;
          }
          throw error;
        }
        observed = probe.observed;
        if (!probe.reached || !probe.elementId) {
          return false;
        }
        if (!perform) {
          return true;
        }
        try {
          outcome = { value: await perform(probe.elementId) };
        } catch (error) {
          if (Locator.isRetryableActionError(error)) {
            observed = 'rejected';
            rejection = error;
            return false;
          }
          outcome = { error };
        }
        return true;
      }, timeout);
    } catch (error) {
      if (error instanceof TimeoutError) {
        const failure = new Error(
          this.describeActionFailure(action, actionability, observed, timeout, rejection),
        );
        if (observed === 'rejected' && rejection instanceof Error) {
          failure.name = rejection.name;
        }
        throw failure;
      }
      throw error;
    }
    if (outcome && 'error' in outcome) {
      throw outcome.error;
    }
    return outcome?.value as T;
  }

  private describeActionFailure(
    action: string,
    actionability: Actionability,
    observed: ObservedState,
    timeout: number,
    rejection: unknown,
  ): string {
    const element = `Failed to ${action}: Element ${this.named}`;
    const after = `after ${timeout}ms`;
    switch (observed) {
      case 'detached':
        return actionability === 'attached'
          ? `${element} not found ${after}`
          : `${element} not visible ${after}: nothing matches the selector`;
      case 'hidden':
        return `${element} not visible ${after}`;
      case 'disabled':
        return `${element} is visible but disabled ${after}. Pass { force: true } to ${action} anyway.`;
      default: {
        const reason = rejection instanceof Error ? rejection.message : String(rejection);
        return `${element} could not be used ${after}: ${reason}`;
      }
    }
  }

  private static isRetryableActionError(error: unknown): boolean {
    const name = error instanceof Error ? error.name : '';
    return [
      WebDriverErrors.StaleElementReferenceError,
      WebDriverErrors.ElementClickInterceptedError,
      WebDriverErrors.ElementNotInteractableError,
    ].some((retryable) => name.includes(retryable));
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
        throw new RetryableError(`Stale element detected: ${error}`, errName);
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

  /**
   * Calls `condition` until it returns true, at once and then after each of POLL_DELAYS_MS, with
   * a last call at the deadline. A `RetryableError` or any driver error means "not yet", but a
   * driver error from the last call is thrown in place of the timeout. A closed window is thrown
   * at once so the WebView wrapper can reattach.
   */
  private async waitUntil(condition: () => Promise<boolean>, timeout: number): Promise<void> {
    const deadline = Date.now() + timeout;
    for (let poll = 0; ; poll += 1) {
      let lastError: unknown;
      try {
        if (await condition()) {
          return;
        }
      } catch (error) {
        if (isNoSuchWindowError(error)) {
          throw new NonRetryableError(
            error instanceof Error ? error.message : String(error),
            'NoSuchWindowError',
          );
        }
        if (!(error instanceof RetryableError)) {
          lastError = error;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (lastError !== undefined) {
          throw lastError;
        }
        throw new TimeoutError(`waitUntil condition timed out after ${timeout}ms`);
      }
      await delay(Math.min(POLL_DELAYS_MS[Math.min(poll, POLL_DELAYS_MS.length - 1)]!, remaining));
    }
  }

  @boxedStep
  async tap(options?: TapOptions) {
    const actionability = options?.force ? 'attached' : 'enabled';
    await this.act(
      'tap',
      actionability,
      options,
      options?.trial ? undefined : (elementId) => this.webDriverClient.elementClick(elementId),
    );
  }

  @boxedStep
  async getText(options?: ActionOptions): Promise<string> {
    return await this.act('getText', 'visible', options, (elementId) =>
      this.webDriverClient.getElementText(elementId),
    );
  }

  @boxedStep
  async boundingBox(options?: ActionOptions): Promise<Rect> {
    return await this.act('boundingBox', 'visible', options, async (elementId) => {
      const { x, y, width, height } = await this.webDriverClient.getElementRect(elementId);
      return { x, y, width, height };
    });
  }

  @boxedStep
  async scroll(direction: ScrollDirection) {
    const element = await this.getElement();
    if (!element) {
      throw new Error(`Failed to scroll: Element ${this.named} not found`);
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
   * A single match is returned as is. Of several, the last in document order wins — the
   * probability of finding the element is higher at higher depth — and with `textToMatch` set,
   * the last whose text matches it: a RegExp `getByText()` can only narrow the driver's search
   * to a substring, if that.
   *
   * A chained locator looks inside its parent's element, trying the parent's matches in the same
   * order until one contains a match.
   */
  async getElement(): Promise<ElementReference | null> {
    for await (const element of this.matches()) {
      return element;
    }
    return null;
  }

  /** Every element this locator matches, the one `getElement()` returns first. */
  private async *matches(): AsyncGenerator<ElementReference> {
    const elements = await this.findAll();
    if (elements.length === 1) {
      yield elements[0]!;
      return;
    }
    for (const element of elements.reverse()) {
      if (this.textToMatch == null) {
        yield element;
        continue;
      }
      const elementText = await this.webDriverClient.getElementText(element[ELEMENT_REFERENCE_ID]);
      if (
        this.textToMatch instanceof RegExp
          ? this.textToMatch.test(elementText)
          : elementText.includes(this.textToMatch)
      ) {
        yield element;
      }
    }
  }

  private async findAll(): Promise<ElementReference[]> {
    if (!this.parent) {
      return await this.findIn(null);
    }
    for await (const root of this.parent.matches()) {
      const found = await this.findIn(root);
      if (found.length > 0) {
        return found;
      }
    }
    return [];
  }

  /** Asks the driver for the matches, in document order, under `root` or the whole screen. */
  private async findIn(root: ElementReference | null): Promise<ElementReference[]> {
    if (this.findStrategy === SCRIPT_FIND_STRATEGY) {
      const found: ElementReference[] | null = await this.webDriverClient.executeScript(
        this.selector,
        [root],
      );
      return found ?? [];
    }
    if (root == null) {
      return await this.webDriverClient.findElements(this.findStrategy, this.selector);
    }
    // An XPath is evaluated against the whole document even from an element unless it is
    // relative, and a chained `getByText(/regex/)` falls back to `//*` natively.
    const selector =
      this.findStrategy === 'xpath' && this.selector.startsWith('//')
        ? `.${this.selector}`
        : this.selector;
    return await this.webDriverClient.findElementsFromElement(
      root[ELEMENT_REFERENCE_ID],
      this.findStrategy,
      selector,
    );
  }

  private resolveTimeout(options?: Partial<ActionOptions>): number {
    return options?.timeout ?? this.timeoutOpts.expectTimeout;
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
}
