import { NATIVE_CONTEXT, WebPage } from '../types';

/** An entry of XCUITest's `mobile: getContexts`: one per page, each its own context. */
type IosContext = { id?: string; title?: string; url?: string };

/** A target in a WebView's DevTools page list (`/json/list`). */
type DevToolsTarget = { id?: string; type?: string; title?: string; url?: string };

/** An entry of UiAutomator2's `mobile: getContexts`: one per WebView, its pages nested. */
type AndroidWebView = { webviewName?: string | null; pages?: DevToolsTarget[] };

/**
 * `mobile: getContexts` as a flat list of pages. iOS lists one context per page; Android lists
 * one per WebView (or browser) with its DevTools targets nested, of which only `page`s can be
 * driven — service workers and other targets are left out.
 */
export function toWebPages(isAndroid: boolean, raw: unknown): WebPage[] {
  const entries = Array.isArray(raw) ? raw : [];
  if (!isAndroid) {
    return (entries as IosContext[])
      .filter((context) => context.id != null && context.id !== NATIVE_CONTEXT)
      .map((context) => ({
        context: context.id!,
        key: context.id!,
        url: context.url ?? '',
        title: context.title ?? '',
      }));
  }
  return (entries as AndroidWebView[]).flatMap((webView) => {
    const context = webView.webviewName;
    if (context == null || context === '') {
      return [];
    }
    return (webView.pages ?? [])
      .filter((target) => target.type == null || target.type === 'page')
      .map((target) => ({
        context,
        key: `${context}#${target.id ?? ''}`,
        url: target.url ?? '',
        title: target.title ?? '',
      }));
  });
}

/** A new page reads `about:blank` (iOS) or nothing until its first navigation commits. */
export function hasLoadedUrl(page: WebPage): boolean {
  return page.url !== '' && page.url !== 'about:blank';
}

/**
 * The DevTools id an Android page's key carries after its context, as `toWebPages()` builds it;
 * `undefined` for an iOS page, whose context is the page itself.
 */
export function devToolsPageId(page: WebPage): string | undefined {
  const prefix = `${page.context}#`;
  return page.key.startsWith(prefix) ? page.key.slice(prefix.length) : undefined;
}
