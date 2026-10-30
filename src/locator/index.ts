import retry from 'async-retry';
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
  TextOptions,
  TimeoutOptions,
  WebDriverErrors,
} from '../types';
import { RetryableError, TimeoutError } from '../types/errors';
import { boxedStep, isInvalidSessionError, isNoSuchWindowError } from '../utils';
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

/** Whether the driver rejected an element reference because its node left the page. */
function isStaleElementError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name.includes(WebDriverErrors.StaleElementReferenceError);
}

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

type ElementState = 'attached' | 'visible' | 'hidden';

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
    const actionOptions = this.toActionOptions(options);
    return await this.withVisibleElement('fill', actionOptions, async (elementId) => {
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
    return await this.withVisibleElement('clear', options, async (elementId) => {
      await this.clearElement(elementId);
    });
  }

  @boxedStep
  async press(key: string, options?: ActionOptions): Promise<void> {
    return await this.withVisibleElement('press', options, async (elementId) => {
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
    return await this.withVisibleElement('inputValue', options, async (elementId) => {
      return await this.readValue(elementId);
    });
  }

  @boxedStep
  async sendKeyStrokes(value: string, options?: ActionOptions): Promise<void> {
    return await this.withVisibleElement('sendKeyStrokes', options, async (elementId) => {
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

  async waitFor(state: ElementState, options?: ActionOptions): Promise<void> {
    await this.waitForElementId(state, options);
  }

  /**
   * Polls until the element is in `state`, then returns the reference id of the element the
   * poll found there (`null` for 'hidden', which nothing need match), so an action can use it
   * without looking the element up again. `timeout: 0` makes a single attempt.
   *
   * 'visible' takes the displayed match `displayedMatch()` picks, so a hidden duplicate (a
   * closed menu, an off-screen copy) never stands in for the one on screen; 'hidden' holds
   * while no match is displayed. 'attached' takes the match `getElement()` returns.
   */
  private async waitForElementId(
    state: ElementState,
    options?: ActionOptions,
  ): Promise<string | null> {
    const timeout = options?.timeout ?? this.timeoutOpts.expectTimeout;
    return await this.waitUntil(async () => {
      if (state === 'attached') {
        const element = await this.getElement();
        return element?.[ELEMENT_REFERENCE_ID] || false;
      }
      const displayed = await this.displayedMatch();
      if (state === 'hidden') {
        return displayed == null ? null : false;
      }
      return displayed || false;
    }, timeout).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        const what = state === 'hidden' ? 'was still on the screen' : `did not become ${state}`;
        throw new TimeoutError(`Element ${this.named} ${what} after ${timeout}ms`);
      }
      throw error;
    });
  }

  /**
   * The reference id of the first displayed element among `matches()` — the last displayed one
   * in document order — or `null` when elements match but none is displayed, or `undefined` when
   * none matches. Each match costs a display check until one passes, so a locator with many
   * hidden matches costs one check per match per poll.
   */
  private async displayedMatch(): Promise<string | null | undefined> {
    let matched = false;
    for await (const element of this.matches()) {
      const elementId = element[ELEMENT_REFERENCE_ID];
      if (!elementId) {
        continue;
      }
      matched = true;
      let isDisplayed: boolean;
      try {
        isDisplayed = await this.webDriverClient.isElementDisplayed(elementId);
      } catch (error) {
        if (isStaleElementError(error)) {
          // A stale node is being re-rendered, not gone: re-find on the next tick for every
          // state, so a transient stale read never counts as "hidden".
          throw new RetryableError(`Stale element detected: ${error}`);
        }
        throw error;
      }
      if (isDisplayed) {
        return elementId;
      }
    }
    return matched ? null : undefined;
  }

  private async waitUntil<ReturnValue>(
    condition: () => ReturnValue | Promise<ReturnValue>,
    timeout: number,
  ): Promise<Exclude<ReturnValue, boolean>> {
    const fn = condition.bind(this.webDriverClient);
    try {
      return await retry(
        async (bail) => {
          try {
            const result = await fn();
            if (result === false) {
              throw new RetryableError(`condition returned false`);
            }
            return result as Exclude<ReturnValue, boolean>;
          } catch (error) {
            // No lookup succeeds in a closed window or on a session the driver has deleted: give
            // up at once, so the WebView can recover (see `recoverFromWindowClosure()` there)
            // rather than after the whole timeout. The error goes out as the driver threw it:
            // one marked `bail` would stop the WebView's own retry as well.
            if (isNoSuchWindowError(error) || isInvalidSessionError(error)) {
              bail(error as Error);
              return undefined as Exclude<ReturnValue, boolean>;
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
    return await this.withVisibleElement('tap', options, async (elementId) => {
      await this.webDriverClient.elementClick(elementId);
    });
  }

  @boxedStep
  async getText(options?: ActionOptions): Promise<string> {
    return await this.withVisibleElement('getText', options, async (elementId) => {
      return await this.webDriverClient.getElementText(elementId);
    });
  }

  @boxedStep
  async boundingBox(options?: ActionOptions): Promise<Rect | null> {
    const read = async () => {
      const elementId = await this.waitForMatch(options);
      if (elementId == null) {
        return null;
      }
      const { x, y, width, height } = await this.webDriverClient.getElementRect(elementId);
      return { x, y, width, height };
    };
    try {
      return await read();
    } catch (error) {
      // As `withVisibleElement()`: the node was re-rendered between the wait and the read.
      if (!isStaleElementError(error)) {
        throw error;
      }
      return await read();
    }
  }

  /**
   * Waits for anything to match, as Playwright's `boundingBox()` does, then returns the
   * displayed match's reference id, or `null` when every match is hidden.
   */
  private async waitForMatch(options?: ActionOptions): Promise<string | null> {
    const timeout = options?.timeout ?? this.timeoutOpts.expectTimeout;
    try {
      return await this.waitUntil(async () => {
        const displayed = await this.displayedMatch();
        return displayed === undefined ? false : displayed;
      }, timeout);
    } catch (error) {
      if (error instanceof TimeoutError) {
        throw new Error(`Failed to boundingBox: Element ${this.named} is not found`);
      }
      throw error;
    }
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

  /**
   * Every element this locator matches, the one `getElement()` returns first. A chained locator
   * searches the parent's matches in turn and stops at the first whose subtree has a match after
   * the text check, so a parent whose children all fail it does not hide the others.
   */
  private async *matches(): AsyncGenerator<ElementReference> {
    if (!this.parent) {
      yield* this.matching(await this.findIn(null));
      return;
    }
    for await (const root of this.parent.matches()) {
      let found = false;
      for await (const element of this.matching(await this.findIn(root))) {
        found = true;
        yield element;
      }
      if (found) {
        return;
      }
    }
  }

  /** Those of `elements` whose text passes `textToMatch`, last first. */
  private async *matching(elements: ElementReference[]): AsyncGenerator<ElementReference> {
    // A lone match needs no text check when the selector already matched the text. A RegExp
    // only narrows the selector to its longest literal part, or to `//*` with none, so a lone
    // match still has to pass the RegExp: a chained `.//*` under a one-child parent is one.
    if (elements.length === 1 && !(this.textToMatch instanceof RegExp)) {
      yield elements[0]!;
      return;
    }
    for (const element of [...elements].reverse()) {
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

  /**
   * Runs `act` on the element `requireVisibleElementId()` found. If the element went stale in
   * between (a framework re-rendered it after the wait), waits and acts once more on the node
   * that replaced it, as a fresh lookup per action used to do. The driver rejects a stale
   * element before acting on it, so the action never runs twice on the page.
   */
  private async withVisibleElement<T>(
    action: string,
    options: ActionOptions | undefined,
    act: (elementId: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await act(await this.requireVisibleElementId(action, options));
    } catch (error) {
      if (!isStaleElementError(error)) {
        throw error;
      }
      return await act(await this.requireVisibleElementId(action, options));
    }
  }

  /**
   * Waits for the element to be visible and returns the reference id the wait found it under,
   * or throws with the action's name so the failure reads as "Failed to fill: …" rather than a
   * bare timeout. Finding it again would cost a second lookup per action, and on iOS every XPath
   * lookup is a full page-source snapshot.
   */
  private async requireVisibleElementId(action: string, options?: ActionOptions): Promise<string> {
    let elementId: string | null;
    try {
      elementId = await this.waitForElementId('visible', options);
    } catch (error) {
      if (error instanceof TimeoutError) {
        throw new Error(`Failed to ${action}: Element ${this.named} not visible`);
      }
      throw error;
    }
    if (!elementId) {
      // Unreachable: a 'visible' wait resolves only with an element.
      throw new Error(`Failed to ${action}: Element ${this.named} is not found`);
    }
    return elementId;
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
