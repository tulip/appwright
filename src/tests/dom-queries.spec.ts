// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { webRoleQuery, webTextQuery } from '../locator/queries';
import { AriaRole, RoleOptions, TextOptions } from '../types';

// Loaded with happy-dom's globals in place, Playwright fires an HTTP request at the page URL
// (localhost:3000), which fails the run as an unhandled error. The queries never call it.
vi.mock('@playwright/test', () => ({ default: {} }));

/**
 * Runs a query's selector the way chromedriver runs `executeScript`: as a function body, with the
 * root element (or null) as `arguments[0]`. This exercises the `toString()`'d function itself.
 */
function run(selector: string, root: Element | null = null): Element[] {
  return new Function(selector).call(null, root) as Element[];
}

function byText(text: string | RegExp, options?: TextOptions, root?: Element | null) {
  return run(webTextQuery(text, options).selector, root);
}

function byRole(role: AriaRole, options?: RoleOptions, root?: Element | null) {
  return run(webRoleQuery(role, options).selector, root);
}

/** A readable handle on each match: its id, else its tag. */
function ids(elements: Element[]): string[] {
  return elements.map((el) => el.id || el.tagName.toLowerCase());
}

function render(html: string) {
  document.head.innerHTML = '<title>Menu Settings</title><style>.x::after{content:"Menu"}</style>';
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('getByText in a WebView', () => {
  test('matches the element holding the text, not its ancestors or the page title', () => {
    render(
      '<div id="outer"><ul role="menu"><li id="device"><b id="bold">Device</b></li></ul></div>',
    );
    expect(ids(byText('Device'))).toEqual(['bold']);
    expect(ids(byText('Menu'))).toEqual([]);
  });

  test('text split across inline children matches their common parent', () => {
    render('<p id="p">Hello <b>wor</b>ld</p>');
    expect(ids(byText('Hello world', { exact: true }))).toEqual(['p']);
  });

  test('normalises whitespace, including non-breaking spaces, on both sides', () => {
    render('<button id="b">\n  Open&nbsp;device\n   menu </button>');
    expect(ids(byText('Open device menu', { exact: true }))).toEqual(['b']);
    expect(ids(byText('  Open   device ', {}))).toEqual(['b']);
  });

  test('exact compares the whole text; the default is a case-sensitive substring', () => {
    render('<span id="a">Next</span><span id="b">Next step</span><span id="c">next</span>');
    expect(ids(byText('Next', { exact: true }))).toEqual(['a']);
    expect(ids(byText('Next'))).toEqual(['a', 'b']);
  });

  test('a RegExp is tested against the normalised text, flags included', () => {
    render('<span id="a">User 12</span><span id="b">user 7</span><div id="c">Users</div>');
    expect(ids(byText(/^user \d+$/i))).toEqual(['a', 'b']);
    // `g` would make test() resume where the previous element matched.
    expect(ids(byText(/User/g))).toEqual(['a', 'c']);
  });

  test('quotes in the text need no escaping', () => {
    render(`<span id="q">Say "hi" & it's done</span>`);
    expect(ids(byText(`Say "hi" & it's done`, { exact: true }))).toEqual(['q']);
  });

  test('skips script and style text; reads a submit input by its value', () => {
    render(
      '<div id="d"><script>var Save = 1;</script><style>.Save{}</style><input id="go" type="submit" value="Save"></div>',
    );
    expect(ids(byText('Save', { exact: true }))).toEqual(['go']);
  });

  test('searches below a root element only', () => {
    render(
      '<div id="one"><span id="a">Item</span></div><div id="two"><span id="b">Item</span></div>',
    );
    expect(ids(byText('Item', {}, document.getElementById('two')))).toEqual(['b']);
  });

  test('refuses an empty string', () => {
    expect(() => webTextQuery('  ')).toThrow('getByText() needs some text');
  });
});

describe('getByRole in a WebView', () => {
  test('implicit and explicit buttons, named by text or aria-label', () => {
    render(`
      <button id="menu">Menu</button>
      <div id="fake" role="button">Menu</div>
      <input id="submit" type="submit" value="Menu">
      <button id="icon" aria-label="Settings"><svg></svg></button>
      <button id="item" role="menuitem">Menu</button>`);
    expect(ids(byRole('button', { name: 'Menu' }))).toEqual(['menu', 'fake', 'submit']);
    expect(ids(byRole('button', { name: 'Settings' }))).toEqual(['icon']);
    expect(ids(byRole('menuitem'))).toEqual(['item']);
  });

  test('the name matches whole by default; exact: false matches a substring', () => {
    render('<button id="a">Settings</button><button id="b">Device Settings</button>');
    expect(ids(byRole('button', { name: 'Settings' }))).toEqual(['a']);
    expect(ids(byRole('button', { name: 'Settings', exact: false }))).toEqual(['a', 'b']);
    expect(ids(byRole('button', { name: /settings$/i }))).toEqual(['a', 'b']);
  });

  test('headings by tag or role, with level', () => {
    render(`
      <h1 id="h1">Device Settings</h1>
      <h2 id="h2">Device Settings</h2>
      <div id="r" role="heading">Device Settings</div>
      <div id="r3" role="heading" aria-level="3">Device Settings</div>`);
    expect(ids(byRole('heading', { name: 'Device Settings' }))).toEqual(['h1', 'h2', 'r', 'r3']);
    expect(ids(byRole('heading', { name: 'Device Settings', level: 2 }))).toEqual(['h2', 'r']);
  });

  test('menu and menuitem come from the role attribute; the first token wins', () => {
    render(`
      <ul id="m" role="menu"><li id="i" role="menuitem">Settings</li></ul>
      <menu id="list"><li>Not a menu</li></menu>
      <div id="sw" role="switch checkbox">Wi-Fi</div>`);
    expect(ids(byRole('menu'))).toEqual(['m']);
    expect(ids(byRole('menuitem', { name: 'Settings' }))).toEqual(['i']);
    expect(ids(byRole('list'))).toEqual(['list']);
    expect(ids(byRole('switch'))).toEqual(['sw']);
    expect(ids(byRole('checkbox'))).toEqual([]);
  });

  test('skips elements hidden from assistive technology', () => {
    render(`
      <div aria-hidden="true"><button id="a">Save</button></div>
      <div style="display: none"><button id="b">Save</button></div>
      <button id="c" style="visibility: hidden">Save</button>
      <button id="d">Save</button>`);
    expect(ids(byRole('button', { name: 'Save' }))).toEqual(['d']);
  });

  test('names from aria-labelledby, a <label>, alt and title', () => {
    render(`
      <span id="lbl" style="display: none">Account URL</span>
      <input id="url" aria-labelledby="lbl">
      <label for="name">Device name</label><input id="name">
      <label>Remember me <input id="remember" type="checkbox"></label>
      <a id="logo" href="/"><img alt="Tulip"></a>
      <button id="t" title="Close"></button>`);
    expect(ids(byRole('textbox', { name: 'Account URL' }))).toEqual(['url']);
    expect(ids(byRole('textbox', { name: 'Device name' }))).toEqual(['name']);
    expect(ids(byRole('checkbox', { name: 'Remember me' }))).toEqual(['remember']);
    expect(ids(byRole('link', { name: 'Tulip' }))).toEqual(['logo']);
    expect(ids(byRole('button', { name: 'Close' }))).toEqual(['t']);
  });

  test('a hidden child does not contribute to the name', () => {
    render('<button id="b">Save<span style="display: none"> draft</span></button>');
    expect(ids(byRole('button', { name: 'Save' }))).toEqual(['b']);
  });

  test('searches below a root element only', () => {
    render(`
      <div data-testid="player-menu" id="pm"><button id="in" aria-label="Settings"></button></div>
      <button id="out" aria-label="Settings"></button>`);
    expect(ids(byRole('button', { name: 'Settings' }, document.getElementById('pm')))).toEqual([
      'in',
    ]);
  });
});

describe('descriptions', () => {
  test('read like the call that made them', () => {
    expect(webTextQuery('Next').description).toBe('getByText("Next")');
    expect(webTextQuery('Next', { exact: true }).description).toBe(
      'getByText("Next", { exact: true })',
    );
    expect(webTextQuery(/^User \d+/).description).toBe('getByText(/^User \\d+/)');
    expect(webRoleQuery('menu').description).toBe('getByRole("menu")');
    expect(webRoleQuery('heading', { name: 'Device Settings', level: 2 }).description).toBe(
      'getByRole("heading", { name: "Device Settings", level: 2 })',
    );
    expect(webRoleQuery('button', { name: 'Set', exact: false }).description).toBe(
      'getByRole("button", { name: "Set", exact: false })',
    );
  });
});
