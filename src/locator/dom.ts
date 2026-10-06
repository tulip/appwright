/**
 * `getByText()` and `getByRole()` for a WebView, evaluated in the page itself: XPath 1.0 has no
 * regular expressions and cannot tell an element's own text from the text of its ancestors.
 */

/** A string to compare, or a `RegExp` sent as its parts (a `RegExp` does not survive JSON). */
export type DomTextMatch = { text: string } | { regex: { source: string; flags: string } };

export type DomQuery =
  | { kind: 'text'; match: DomTextMatch; exact: boolean }
  | { kind: 'role'; role: string; name?: DomTextMatch; exact: boolean; level?: number };

/**
 * Returns the elements under `root` (or the whole document) that `query` matches, in document
 * order.
 *
 * Text, like Playwright's `getByText()`: an element matches when its whitespace-normalised text
 * matches and none of its child elements' text does, so `<li><b>Device</b></li>` yields the `<b>`
 * alone instead of every ancestor up to `<body>`. `<script>`, `<style>` and `<head>` hold no
 * visible text and never match. A `RegExp` is tested against the normalised text.
 *
 * Role, like Playwright's `getByRole()`: the element's explicit `role` or its implicit HTML one
 * (`<button>`, `<h2>`, `<a href>`, `<input type="checkbox">`…), skipping elements hidden from
 * assistive technology (`aria-hidden="true"`, `display: none`, `visibility: hidden`). `name` is
 * compared against the accessible name: `aria-labelledby`, `aria-label`, a `<label>`, `alt` /
 * `value`, the text content for roles named by their content (buttons, links, headings, menu
 * items…), then `title` / `placeholder`.
 *
 * Runs in the page, not in Node: `toString()`'d into `executeScript`, so it must not reference
 * anything outside its own body, and it sticks to syntax every WebView in use runs (no optional
 * chaining or nullish coalescing).
 */
export function queryDom(root: Element | null, query: DomQuery): Element[] {
  const doc = document;
  const NAME_FROM_CONTENT = [
    'button',
    'cell',
    'checkbox',
    'columnheader',
    'gridcell',
    'heading',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'row',
    'rowheader',
    'switch',
    'tab',
    'tooltip',
    'treeitem',
  ];
  const textCache = new Map<Element, string>();
  const hiddenCache = new Map<Element, boolean>();

  function tagOf(el: Element): string {
    return el.nodeName.toUpperCase();
  }

  function normalize(value: string): string {
    return value.replace(/​/g, '').replace(/\s+/g, ' ').trim();
  }

  function holdsNoText(el: Element): boolean {
    const tag = tagOf(el);
    return (
      tag === 'SCRIPT' ||
      tag === 'STYLE' ||
      tag === 'NOSCRIPT' ||
      tag === 'TEMPLATE' ||
      (doc.head != null && doc.head.contains(el))
    );
  }

  function isTextButton(el: Element): el is HTMLInputElement {
    const type = (el as HTMLInputElement).type;
    return tagOf(el) === 'INPUT' && (type === 'button' || type === 'submit' || type === 'reset');
  }

  /** The element's text content, minus script/style; a button-like `<input>` reads its value. */
  function rawText(el: Element): string {
    const cached = textCache.get(el);
    if (cached !== undefined) {
      return cached;
    }
    let text = '';
    if (!holdsNoText(el)) {
      if (isTextButton(el)) {
        text = el.value;
      } else {
        for (let child = el.firstChild; child; child = child.nextSibling) {
          if (child.nodeType === 3) {
            text += child.nodeValue || '';
          } else if (child.nodeType === 1) {
            text += rawText(child as Element);
          }
        }
      }
    }
    textCache.set(el, text);
    return text;
  }

  function textMatcher(match: DomTextMatch, exact: boolean): (value: string) => boolean {
    if ('regex' in match) {
      // `g`/`y` make `test()` stateful: a second element would resume where the first matched.
      const re = new RegExp(match.regex.source, match.regex.flags.replace(/[gy]/g, ''));
      return (value) => re.test(normalize(value));
    }
    const wanted = normalize(match.text);
    return exact
      ? (value) => normalize(value) === wanted
      : (value) => normalize(value).indexOf(wanted) !== -1;
  }

  /** `aria-hidden` or `display: none` on the element or an ancestor, or `visibility: hidden`. */
  function isHidden(el: Element): boolean {
    for (let node: Element | null = el; node; node = node.parentElement) {
      let hidden = hiddenCache.get(node);
      if (hidden === undefined) {
        hidden =
          node.getAttribute('aria-hidden') === 'true' || getComputedStyle(node).display === 'none';
        hiddenCache.set(node, hidden);
      }
      if (hidden) {
        return true;
      }
    }
    const visibility = getComputedStyle(el).visibility;
    return visibility === 'hidden' || visibility === 'collapse';
  }

  function isBlock(el: Element): boolean {
    const display = getComputedStyle(el).display;
    return display !== '' && display !== 'contents' && display.indexOf('inline') !== 0;
  }

  function hasSectioningAncestor(el: Element): boolean {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const tag = tagOf(node);
      if (
        tag === 'ARTICLE' ||
        tag === 'ASIDE' ||
        tag === 'MAIN' ||
        tag === 'NAV' ||
        tag === 'SECTION'
      ) {
        return true;
      }
    }
    return false;
  }

  function hasAuthorName(el: Element): boolean {
    return !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'));
  }

  function inputRole(el: HTMLInputElement): string | null {
    switch (el.type) {
      case 'button':
      case 'file':
      case 'image':
      case 'reset':
      case 'submit':
        return 'button';
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'range':
        return 'slider';
      case 'number':
        return 'spinbutton';
      case 'hidden':
        return null;
      case 'search':
        return el.hasAttribute('list') ? 'combobox' : 'searchbox';
      case 'email':
      case 'tel':
      case 'text':
      case 'url':
        return el.hasAttribute('list') ? 'combobox' : 'textbox';
      default:
        return 'textbox';
    }
  }

  function implicitRole(el: Element): string | null {
    const tag = tagOf(el);
    switch (tag) {
      case 'A':
      case 'AREA':
        return el.hasAttribute('href') ? 'link' : null;
      case 'ARTICLE':
        return 'article';
      case 'ASIDE':
        return 'complementary';
      case 'BUTTON':
        return 'button';
      case 'DATALIST':
        return 'listbox';
      case 'DD':
        return 'definition';
      case 'DETAILS':
      case 'FIELDSET':
      case 'OPTGROUP':
        return 'group';
      case 'DIALOG':
        return 'dialog';
      case 'DT':
        return 'term';
      case 'FIGURE':
        return 'figure';
      case 'FOOTER':
        return hasSectioningAncestor(el) ? null : 'contentinfo';
      case 'FORM':
        return hasAuthorName(el) ? 'form' : null;
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6':
        return 'heading';
      case 'HEADER':
        return hasSectioningAncestor(el) ? null : 'banner';
      case 'HR':
        return 'separator';
      case 'IMG':
        return el.getAttribute('alt') === '' && !el.getAttribute('title') ? 'presentation' : 'img';
      case 'INPUT':
        return inputRole(el as HTMLInputElement);
      case 'LI':
        return 'listitem';
      case 'MAIN':
        return 'main';
      case 'MENU':
      case 'OL':
      case 'UL':
        return 'list';
      case 'METER':
        return 'meter';
      case 'NAV':
        return 'navigation';
      case 'OPTION':
        return 'option';
      case 'OUTPUT':
        return 'status';
      case 'P':
        return 'paragraph';
      case 'PROGRESS':
        return 'progressbar';
      case 'SECTION':
        return hasAuthorName(el) ? 'region' : null;
      case 'SELECT': {
        const select = el as HTMLSelectElement;
        return select.multiple || select.size > 1 ? 'listbox' : 'combobox';
      }
      case 'TABLE':
        return 'table';
      case 'TBODY':
      case 'TFOOT':
      case 'THEAD':
        return 'rowgroup';
      case 'TD':
        return 'cell';
      case 'TEXTAREA':
        return 'textbox';
      case 'TH':
        return el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
      case 'TR':
        return 'row';
      default:
        return null;
    }
  }

  /** The first token of `role`, else the implicit role. */
  function roleOf(el: Element): string | null {
    const explicit = normalize(el.getAttribute('role') || '');
    return explicit ? explicit.split(' ')[0]! : implicitRole(el);
  }

  function levelOf(el: Element): number | undefined {
    const aria = parseInt(el.getAttribute('aria-level') || '', 10);
    if (!isNaN(aria)) {
      return aria;
    }
    const heading = /^H([1-6])$/.exec(tagOf(el));
    if (heading) {
      return Number(heading[1]);
    }
    // ARIA's default for an explicit `role="heading"` without `aria-level`.
    return roleOf(el) === 'heading' ? 2 : undefined;
  }

  /** The name an element contributes from its content: text, plus children's labels and alts. */
  function contentName(el: Element, includeHidden: boolean): string {
    let out = '';
    for (let child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        out += child.nodeValue || '';
        continue;
      }
      if (child.nodeType !== 1) {
        continue;
      }
      const element = child as Element;
      if (holdsNoText(element) || (!includeHidden && isHidden(element))) {
        continue;
      }
      const tag = tagOf(element);
      let piece: string;
      const label = normalize(element.getAttribute('aria-label') || '');
      if (label) {
        piece = label;
      } else if (tag === 'IMG' || tag === 'AREA') {
        piece = element.getAttribute('alt') || '';
      } else if (isTextButton(element)) {
        piece = element.value;
      } else {
        piece = contentName(element, includeHidden);
      }
      out += isBlock(element) ? ' ' + piece + ' ' : piece;
    }
    return out;
  }

  function nativeName(el: Element): string {
    const tag = tagOf(el);
    if (isTextButton(el)) {
      return normalize(el.value);
    }
    if (tag === 'INPUT' && (el as HTMLInputElement).type === 'image') {
      return normalize(el.getAttribute('alt') || '');
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) {
      const parts: string[] = [];
      for (let i = 0; i < labels.length; i++) {
        parts.push(contentName(labels[i]!, false));
      }
      const fromLabels = normalize(parts.join(' '));
      if (fromLabels) {
        return fromLabels;
      }
    }
    if (tag === 'IMG' || tag === 'AREA') {
      return normalize(el.getAttribute('alt') || '');
    }
    const caption =
      tag === 'FIELDSET'
        ? el.querySelector('legend')
        : tag === 'TABLE'
        ? el.querySelector('caption')
        : null;
    return caption ? normalize(contentName(caption, false)) : '';
  }

  function accessibleName(el: Element, role: string): string {
    const labelledBy = normalize(el.getAttribute('aria-labelledby') || '');
    if (labelledBy) {
      const parts: string[] = [];
      const ids = labelledBy.split(' ');
      for (let i = 0; i < ids.length; i++) {
        const target = doc.getElementById(ids[i]!);
        if (target) {
          // A label element is read even while hidden: hiding it is how pages label visually.
          parts.push(
            normalize(target.getAttribute('aria-label') || '') || contentName(target, true),
          );
        }
      }
      const name = normalize(parts.join(' '));
      if (name) {
        return name;
      }
    }
    const label = normalize(el.getAttribute('aria-label') || '');
    if (label) {
      return label;
    }
    const native = nativeName(el);
    if (native) {
      return native;
    }
    if (NAME_FROM_CONTENT.indexOf(role) !== -1) {
      const content = normalize(contentName(el, false));
      if (content) {
        return content;
      }
    }
    return (
      normalize(el.getAttribute('title') || '') || normalize(el.getAttribute('placeholder') || '')
    );
  }

  const scope: Document | Element = root || doc;
  const all = scope.querySelectorAll('*');
  const result: Element[] = [];

  if (query.kind === 'text') {
    const matches = textMatcher(query.match, query.exact);
    for (let i = 0; i < all.length; i++) {
      const el = all[i]!;
      if (holdsNoText(el) || !matches(rawText(el))) {
        continue;
      }
      let childMatches = false;
      for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
        if (matches(rawText(child))) {
          childMatches = true;
          break;
        }
      }
      if (!childMatches) {
        result.push(el);
      }
    }
    return result;
  }

  const nameMatches = query.name ? textMatcher(query.name, query.exact) : null;
  for (let i = 0; i < all.length; i++) {
    const el = all[i]!;
    if (roleOf(el) !== query.role) {
      continue;
    }
    if (query.level != null && levelOf(el) !== query.level) {
      continue;
    }
    if (isHidden(el)) {
      continue;
    }
    if (nameMatches && !nameMatches(accessibleName(el, query.role))) {
      continue;
    }
    result.push(el);
  }
  return result;
}
