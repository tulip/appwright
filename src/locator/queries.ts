import { AriaRole, IdOptions, LabelOptions, RoleOptions, TextOptions } from '../types';
import { escapeQuotes, escapeRegExp, longestDeterministicGroup } from '../utils';
import { DomQuery, DomTextMatch, queryDom } from './dom';

/**
 * Not a WebDriver strategy: the selector is a script, run with `executeScript`, that returns the
 * matching elements. Used for WebView matches that XPath and CSS cannot express.
 */
export const SCRIPT_FIND_STRATEGY = 'appwright script';

/** What a `getBy*()` call compiles to: how to ask the driver for the element. */
export type LocatorQuery = {
  selector: string;
  findStrategy: string;
  /** Narrows several matches down by their text; see `Locator.getElement()`. */
  textToMatch?: string | RegExp;
  /** Shown in step titles and errors in place of a selector nobody could read. */
  description?: string;
};

const IOS_EDITABLE_TYPES = [
  'XCUIElementTypeTextField',
  'XCUIElementTypeSecureTextField',
  'XCUIElementTypeTextView',
];

/**
 * The class names Android reports for a text field: an `EditText` subclass reports
 * `android.widget.EditText`, except the autocomplete fields (a `SearchView`'s included), which
 * report `AutoCompleteTextView` / `MultiAutoCompleteTextView`.
 */
const ANDROID_EDITABLE_CLASS = '.classNameMatches(".*(EditText|AutoCompleteTextView)")';

const IOS_EDITABLE_FILTER = ` AND type IN {${IOS_EDITABLE_TYPES.map((type) => `"${type}"`).join(
  ', ',
)}}`;

function strategyFor(isAndroid: boolean): string {
  return isAndroid ? '-android uiautomator' : '-ios predicate string';
}

export function nativeTextQuery(
  isAndroid: boolean,
  text: string | RegExp,
  { exact = false }: TextOptions = {},
): LocatorQuery {
  if (text instanceof RegExp) {
    const substringForContains = longestDeterministicGroup(text);
    if (!substringForContains) {
      return { selector: '//*', findStrategy: 'xpath', textToMatch: text };
    }
    const selector = isAndroid
      ? `textContains("${substringForContains}")`
      : `label CONTAINS "${substringForContains}"`;
    return { selector, findStrategy: strategyFor(isAndroid), textToMatch: text };
  }
  const quoted = escapeQuotes(text);
  let selector: string;
  if (isAndroid) {
    selector = exact ? `text("${quoted}")` : `textContains("${quoted}")`;
  } else {
    selector = exact ? `label == "${quoted}"` : `label CONTAINS "${quoted}"`;
  }
  return { selector, findStrategy: strategyFor(isAndroid), textToMatch: text };
}

export function nativeIdQuery(
  isAndroid: boolean,
  id: string,
  { exact = true, editable = false }: IdOptions = {},
): LocatorQuery {
  let selector: string;
  if (isAndroid) {
    // `resourceIdMatches` takes a regular expression, so the id is escaped to match literally.
    selector = exact
      ? `resourceId("${escapeQuotes(id)}")`
      : `resourceIdMatches("${escapeQuotes(`.*${escapeRegExp(id)}.*`)}")`;
    if (editable) {
      selector = `new UiSelector().${selector}${ANDROID_EDITABLE_CLASS}`;
    }
  } else {
    const quoted = escapeQuotes(id);
    selector = exact ? `name == "${quoted}"` : `name CONTAINS "${quoted}"`;
    if (editable) {
      selector += IOS_EDITABLE_FILTER;
    }
  }
  // No `textToMatch`: the selector already pins the id, and an element's text is not its id, so
  // filtering on it turned two nodes that share an id into no match at all.
  return { selector, findStrategy: strategyFor(isAndroid) };
}

export function nativeLabelQuery(
  isAndroid: boolean,
  label: string,
  { exact = true, editable = false }: LabelOptions = {},
): LocatorQuery {
  const quoted = escapeQuotes(label);
  if (isAndroid) {
    const method = exact ? 'description' : 'descriptionContains';
    const className = editable ? ANDROID_EDITABLE_CLASS : '';
    return {
      selector: `new UiSelector().${method}("${quoted}")${className}`,
      findStrategy: '-android uiautomator',
    };
  }
  const typeFilter = editable ? IOS_EDITABLE_FILTER : '';
  return {
    selector: `label ${exact ? '==' : 'CONTAINS'} "${quoted}"${typeFilter}`,
    findStrategy: '-ios predicate string',
  };
}

function domTextMatch(value: string | RegExp): DomTextMatch {
  return value instanceof RegExp
    ? { regex: { source: value.source, flags: value.flags } }
    : { text: value };
}

/** `"Save"` or `/^Save/i`, the way a reader would write the argument. */
function formatMatch(value: string | RegExp): string {
  return value instanceof RegExp ? String(value) : JSON.stringify(value);
}

function scriptQuery(query: DomQuery, description: string): LocatorQuery {
  return {
    selector: `return (${queryDom.toString()})(arguments[0], ${JSON.stringify(query)});`,
    findStrategy: SCRIPT_FIND_STRATEGY,
    description,
  };
}

export function webTextQuery(
  text: string | RegExp,
  { exact = false }: TextOptions = {},
): LocatorQuery {
  if (typeof text === 'string' && text.trim() === '') {
    throw new Error('getByText() needs some text to match; an empty string matches every element.');
  }
  const options = exact && typeof text === 'string' ? ', { exact: true }' : '';
  return scriptQuery(
    { kind: 'text', match: domTextMatch(text), exact },
    `getByText(${formatMatch(text)}${options})`,
  );
}

export function webRoleQuery(
  role: AriaRole,
  { name, exact = true, level }: RoleOptions = {},
): LocatorQuery {
  const options: string[] = [];
  if (name != null) {
    options.push(`name: ${formatMatch(name)}`);
    if (!exact && typeof name === 'string') {
      options.push('exact: false');
    }
  }
  if (level != null) {
    options.push(`level: ${level}`);
  }
  return scriptQuery(
    {
      kind: 'role',
      role,
      ...(name != null && { name: domTextMatch(name) }),
      exact,
      ...(level != null && { level }),
    },
    `getByRole(${JSON.stringify(role)}${options.length ? `, { ${options.join(', ')} }` : ''})`,
  );
}

export function webLabelQuery(label: string, { exact = true }: LabelOptions = {}): LocatorQuery {
  return {
    selector: `[aria-label${exact ? '' : '*'}="${escapeQuotes(label)}"]`,
    findStrategy: 'css selector',
  };
}

export function webTestIdQuery(testId: string): LocatorQuery {
  return { selector: `[data-testid="${escapeQuotes(testId)}"]`, findStrategy: 'css selector' };
}
