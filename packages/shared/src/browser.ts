/**
 * The wire contract of `POST /api/browser` — the JSON an app's `@bundled/yaar-web`
 * call actually resolves to.
 *
 * Most browser actions answer with *formatted text* (a page-state summary), so
 * there is no structured type for them: `data` is a string. The shapes below are
 * the ones that come back as JSON. The server builds them in
 * `packages/server/src/lib/browser/session.ts` and `features/browser/actions.ts`;
 * the app-facing declarations in `packages/compiler/src/bundled-types/index.d.ts`
 * restate them (that file is sliced verbatim into what an agent reads, so it
 * cannot import), and `bundled-types-parity.test.ts` proves the two agree.
 */

/** The envelope every `/api/browser` action answers with. */
export type BrowserActionResponse<T = string> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** The envelope of an action that returns a picture (`screenshot`, `extract_images`). */
export type BrowserImageResponse =
  | {
      ok: true;
      text: string;
      images: Array<{ data: string; mimeType: string; src?: string }>;
    }
  | { ok: false; error: string };

/** One open tab, as `list_tabs` reports it. */
export interface BrowserTabSummary {
  id: string;
  url: string;
  title: string;
  mobile: boolean;
  /** The desktop window showing this tab, when one is open. */
  windowId?: string;
  /** Present when the tab is pointed at YAAR itself. */
  isSelf?: true;
}

/** What `scroll_to_bottom` answers. */
export interface BrowserScrollToBottomResult {
  steps: number;
  finalHeight: number;
  reachedBottom: boolean;
}

/** What `html` answers with `includeMeta: true`. */
export interface BrowserHtmlWithMeta {
  html: string;
  url: string;
  title: string;
  readyState: string;
}

/** One element the `annotate` overlay numbered. */
export interface BrowserAnnotatedElement {
  index: number;
  tag: string;
  text: string;
  href?: string | null;
  selector?: string | null;
  x: number;
  y: number;
}

/** One cookie, as `get_cookies` reports it. */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}
