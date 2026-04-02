/**
 * BrowserSession — wraps one Chrome tab via CDP.
 *
 * Each session tracks its bound YAAR window, current URL, and latest screenshot.
 * Screenshots are stored in memory as WebP buffers and served via HTTP.
 *
 * Emits 'updated' events after each state change so listeners (SSE, etc.)
 * can push live updates to the browser app iframe.
 */

import { EventEmitter } from 'events';
import { CDPClient } from './cdp.js';
import type { PageState, PageContent } from './types.js';
import {
  PAGE_STATE,
  VIEWPORT_TEXT,
  VIEWPORT_LINKS,
  URL_AND_TITLE,
  FIND_BY_SELECTOR,
  FIND_BY_TEXT,
  STRIP_TARGET_BLANK,
  ELEMENT_AT_POINT,
  ANNOTATE_ELEMENTS,
  REMOVE_ANNOTATIONS,
  FOCUS_AND_CLEAR,
  SET_VALUE,
  EXTRACT_CONTENT,
  EXTRACT_IMAGES,
  FIND_MAIN_CONTENT,
} from './page-scripts.js';

const DESKTOP_WIDTH = 1280;
const DESKTOP_HEIGHT = 800;
const MOBILE_WIDTH = 390;
const MOBILE_HEIGHT = 844;
const SCREENSHOT_QUALITY = 95;
const TEXT_SNIPPET_LENGTH = 500;

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

export interface BrowserSessionUpdate {
  url: string;
  title: string;
  version: number;
}

export interface BrowserSessionOptions {
  mobile?: boolean;
}

export class BrowserSession extends EventEmitter {
  readonly id: string;
  readonly mobile: boolean;
  windowId: string | undefined;
  openerBrowserId: string | undefined;
  currentUrl = 'about:blank';
  currentTitle = '';
  lastScreenshot: Buffer | null = null;
  lastActivity = Date.now();
  version = 0;

  private cdp: CDPClient;
  private closed = false;

  private constructor(id: string, cdp: CDPClient, mobile: boolean) {
    super();
    this.id = id;
    this.cdp = cdp;
    this.mobile = mobile;
  }

  static async create(
    id: string,
    debuggerUrl: string,
    options?: BrowserSessionOptions,
  ): Promise<BrowserSession> {
    const mobile = options?.mobile ?? false;
    const cdp = await CDPClient.connect(debuggerUrl);
    const session = new BrowserSession(id, cdp, mobile);

    // Enable required CDP domains
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Auto-dismiss JavaScript dialogs (alert/confirm/prompt/beforeunload).
    // These block ALL CDP commands until handled, causing tool hangs.
    cdp.on('Page.javascriptDialogOpening', (params: unknown) => {
      const p = params as { message?: string; type?: string };
      console.log(`[browser] Auto-dismissing JS dialog: ${p.type} "${p.message}"`);
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });

    // Set viewport
    const width = mobile ? MOBILE_WIDTH : DESKTOP_WIDTH;
    const height = mobile ? MOBILE_HEIGHT : DESKTOP_HEIGHT;
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: mobile ? 3 : 1,
      mobile,
    });

    // Enable touch emulation for mobile
    if (mobile) {
      await cdp.send('Emulation.setTouchEmulationEnabled', {
        enabled: true,
        maxTouchPoints: 5,
      });
    }

    // Set user agent
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: mobile ? MOBILE_UA : DESKTOP_UA,
    });

    return session;
  }

  private touch() {
    this.lastActivity = Date.now();
  }

  /** Bump version and emit 'updated' so SSE listeners can push to the browser app. */
  private notifyUpdate(): void {
    this.version++;
    this.emit('updated', {
      url: this.currentUrl,
      title: this.currentTitle,
      version: this.version,
    } satisfies BrowserSessionUpdate);
  }

  private async takeScreenshot(clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
  }): Promise<Buffer> {
    const result = await this.cdp.send('Page.captureScreenshot', {
      format: 'webp',
      quality: SCREENSHOT_QUALITY,
      ...(clip ? { clip } : {}),
    });
    const buf = Buffer.from(result.data, 'base64');
    // Only cache full-page screenshots (not clipped regions)
    if (!clip) this.lastScreenshot = buf;
    return buf;
  }

  /** Evaluate a JS expression in the page and return the value. */
  private async eval<T>(expression: string): Promise<T | undefined> {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    return result.result?.value;
  }

  /** Evaluate a JS function string with one argument: `(fn)(arg)`. */
  private async evalFn<T>(fn: string, arg: unknown): Promise<T | undefined> {
    return this.eval<T>(`(${fn})(${JSON.stringify(arg)})`);
  }

  private async getPageState(): Promise<PageState> {
    const { url, title, activeElement, scrollY, scrollHeight, viewportHeight } = (await this.eval<{
      url: string;
      title: string;
      activeElement: PageState['activeElement'] | null;
      scrollY: number;
      scrollHeight: number;
      viewportHeight: number;
    }>(PAGE_STATE)) || {
      url: this.currentUrl,
      title: '',
      activeElement: null,
      scrollY: 0,
      scrollHeight: 0,
      viewportHeight: 0,
    };

    this.currentUrl = url;
    this.currentTitle = title;

    let textSnippet = '';
    try {
      textSnippet = (await this.eval<string>(VIEWPORT_TEXT)) || '';
      if (textSnippet.length > TEXT_SNIPPET_LENGTH) {
        textSnippet = textSnippet.slice(0, TEXT_SNIPPET_LENGTH) + '...';
      }
    } catch {
      /* page not ready */
    }

    let visibleLinks: Array<{ text: string; href: string }> | undefined;
    try {
      const links = await this.eval<Array<{ text: string; href: string }>>(VIEWPORT_LINKS);
      if (links && links.length > 0) visibleLinks = links;
    } catch {
      /* page not ready */
    }

    const state: PageState = { url, title, textSnippet, scrollY, scrollHeight, viewportHeight };
    if (activeElement) state.activeElement = activeElement;
    if (visibleLinks) state.visibleLinks = visibleLinks;
    return state;
  }

  async navigate(
    url: string,
    waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'load',
  ): Promise<PageState> {
    this.touch();

    const NAV_TIMEOUT = 15_000;

    if (waitUntil === 'domcontentloaded') {
      const dcPromise = this.cdp.waitForEvent('Page.domContentEventFired', NAV_TIMEOUT);
      await this.cdp.send('Page.navigate', { url });
      await dcPromise.catch(() => {});
    } else if (waitUntil === 'networkidle') {
      const loadPromise = this.cdp.waitForEvent('Page.loadEventFired', NAV_TIMEOUT);
      await this.cdp.send('Page.navigate', { url });
      await loadPromise.catch(() => {});
      await this.waitForNetworkIdle(500, 10_000);
    } else {
      // 'load' (default) — wait for DOMContentLoaded first, then race load vs timeout.
      // Many pages fire DOMContentLoaded quickly but 'load' can stall on slow resources.
      const dcPromise = this.cdp.waitForEvent('Page.domContentEventFired', NAV_TIMEOUT);
      const loadPromise = this.cdp.waitForEvent('Page.loadEventFired', NAV_TIMEOUT);
      await this.cdp.send('Page.navigate', { url });
      await dcPromise.catch(() => {});
      await Promise.race([loadPromise.catch(() => {}), new Promise((r) => setTimeout(r, 5_000))]);
    }

    // Small delay for dynamic content
    await new Promise((r) => setTimeout(r, 500));

    if (!this.closed) {
      // Fire-and-forget: cache screenshot for browser app SSE, don't block navigation result
      this.takeScreenshot().then(
        () => this.notifyUpdate(),
        () => {
          /* screenshot failure is non-fatal */
        },
      );
    }
    const state = await this.getPageState();
    console.log(`[browser:nav] ${state.title} (${waitUntil})`);
    this.notifyUpdate();
    return state;
  }

  /** Wait until no network requests for `quietMs`, up to `timeoutMs`. */
  private async waitForNetworkIdle(quietMs: number, timeoutMs: number): Promise<void> {
    await this.cdp.send('Network.enable');
    let inflight = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    return new Promise<void>((resolve) => {
      const deadline = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);

      const checkQuiet = () => {
        if (timer) clearTimeout(timer);
        if (inflight <= 0) {
          timer = setTimeout(() => {
            cleanup();
            resolve();
          }, quietMs);
        }
      };

      const onRequest = () => {
        inflight++;
        if (timer) clearTimeout(timer);
      };
      const onFinish = () => {
        inflight--;
        checkQuiet();
      };

      this.cdp.on('Network.requestWillBeSent', onRequest);
      this.cdp.on('Network.loadingFinished', onFinish);
      this.cdp.on('Network.loadingFailed', onFinish);

      const cleanup = () => {
        clearTimeout(deadline);
        if (timer) clearTimeout(timer);
        this.cdp.off('Network.requestWillBeSent', onRequest);
        this.cdp.off('Network.loadingFinished', onFinish);
        this.cdp.off('Network.loadingFailed', onFinish);
        this.cdp.send('Network.disable').catch(() => {});
      };

      // Start checking immediately in case no requests are pending
      checkQuiet();
    });
  }

  async click(
    selector?: string,
    text?: string,
    x?: number,
    y?: number,
    index?: number,
  ): Promise<PageState> {
    this.touch();

    const urlBefore = this.currentUrl;
    let clickX: number;
    let clickY: number;
    let clickTarget: PageState['clickTarget'] | undefined;

    if (x !== undefined && y !== undefined) {
      // Coordinate-based click
      clickX = x;
      clickY = y;
      // Validate what's at the click coordinates
      try {
        const elementInfo = await this.eval<{ tag: string; text: string; href?: string }>(
          `(${ELEMENT_AT_POINT})(${x}, ${y})`,
        );
        if (elementInfo) {
          clickTarget = {
            tag: elementInfo.tag,
            text: elementInfo.text,
            candidateCount: 1,
            ...(elementInfo.href ? { href: elementInfo.href } : {}),
          };
        }
      } catch {
        /* non-fatal */
      }
    } else {
      if (!selector && !text) {
        throw new Error('Either selector, text, or x/y coordinates must be provided');
      }

      const coords = selector
        ? await this.evalFn<{
            x: number;
            y: number;
            tag: string;
            text: string;
            candidateCount: number;
            selector?: string;
            href?: string;
          }>(FIND_BY_SELECTOR, selector)
        : await this.eval<{
            x: number;
            y: number;
            tag: string;
            text: string;
            candidateCount: number;
            selector?: string;
            href?: string;
          }>(`(${FIND_BY_TEXT})(${JSON.stringify(text)}, ${index ?? 0})`);

      if (!coords) {
        throw new Error(`Element not found: ${selector || text}`);
      }

      clickX = coords.x;
      clickY = coords.y;
      clickTarget = {
        tag: coords.tag,
        text: coords.text,
        candidateCount: coords.candidateCount,
        ...(coords.selector ? { selector: coords.selector } : {}),
        ...(coords.href ? { href: coords.href } : {}),
      };
    }

    // Strip target="_blank" so links navigate in-place
    await this.eval(STRIP_TARGET_BLANK).catch(() => {});

    // Dispatch mouse click
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: clickX,
      y: clickY,
      button: 'left',
      clickCount: 1,
    });
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: clickX,
      y: clickY,
      button: 'left',
      clickCount: 1,
    });

    // Wait for potential navigation or re-render
    await new Promise((r) => setTimeout(r, 500));

    if (!this.closed) await this.takeScreenshot();
    const state = await this.getPageState();
    state.urlChanged = state.url !== urlBefore;
    if (clickTarget) state.clickTarget = clickTarget;
    this.notifyUpdate();
    return state;
  }

  async type(selector: string, text: string): Promise<PageState> {
    this.touch();
    const urlBefore = this.currentUrl;

    // Click element first to fire SPA focus handlers that el.focus() alone misses
    const coords = await this.evalFn<{ x: number; y: number }>(FIND_BY_SELECTOR, selector);
    if (coords) {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: coords.x,
        y: coords.y,
        button: 'left',
        clickCount: 1,
      });
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: coords.x,
        y: coords.y,
        button: 'left',
        clickCount: 1,
      });
      await new Promise((r) => setTimeout(r, 100));
    }

    // Focus and clear the input
    await this.evalFn(FOCUS_AND_CLEAR, selector);

    // Insert text via CDP (for visual keystroke rendering)
    await this.cdp.send('Input.insertText', { text });

    // Also set value via JS + native setter to ensure DOM is updated
    // (Input.insertText can silently fail to update .value on some pages)
    await this.evalFn(SET_VALUE, { sel: selector, text });

    if (!this.closed) await this.takeScreenshot();
    const state = await this.getPageState();
    state.urlChanged = state.url !== urlBefore;
    this.notifyUpdate();
    return state;
  }

  async press(key: string, selector?: string): Promise<PageState> {
    this.touch();
    const urlBefore = this.currentUrl;

    // If selector provided, click element first to ensure focus
    if (selector) {
      const coords = await this.evalFn<{ x: number; y: number }>(FIND_BY_SELECTOR, selector);
      if (coords) {
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: coords.x,
          y: coords.y,
          button: 'left',
          clickCount: 1,
        });
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: coords.x,
          y: coords.y,
          button: 'left',
          clickCount: 1,
        });
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const keyMap: Record<string, { key: string; code: string; keyCode: number }> = {
      Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
      Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
      Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
      Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      Space: { key: ' ', code: 'Space', keyCode: 32 },
    };

    const desc = keyMap[key] || {
      key,
      code: `Key${key.toUpperCase()}`,
      keyCode: key.charCodeAt(0),
    };

    // Add text/unmodifiedText for keys that produce characters
    const keyDownExtra: Record<string, unknown> = {};
    if (desc.key === 'Enter') {
      keyDownExtra.text = '\r';
      keyDownExtra.unmodifiedText = '\r';
    } else if (desc.key === ' ') {
      keyDownExtra.text = ' ';
      keyDownExtra.unmodifiedText = ' ';
    }

    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: desc.key,
      code: desc.code,
      windowsVirtualKeyCode: desc.keyCode,
      nativeVirtualKeyCode: desc.keyCode,
      ...keyDownExtra,
    });
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: desc.key,
      code: desc.code,
      windowsVirtualKeyCode: desc.keyCode,
      nativeVirtualKeyCode: desc.keyCode,
    });

    await new Promise((r) => setTimeout(r, 300));
    if (!this.closed) await this.takeScreenshot();
    const state = await this.getPageState();
    state.urlChanged = state.url !== urlBefore;
    this.notifyUpdate();
    return state;
  }

  async navigateHistory(direction: 'back' | 'forward'): Promise<PageState> {
    this.touch();

    await this.eval(direction === 'back' ? 'history.back()' : 'history.forward()');
    // Wait for navigation (non-fatal timeout)
    await this.cdp.waitForEvent('Page.frameNavigated', 5_000).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));

    if (!this.closed) await this.takeScreenshot();
    const state = await this.getPageState();
    this.notifyUpdate();
    return state;
  }

  async hover(opts: {
    selector?: string;
    text?: string;
    x?: number;
    y?: number;
    index?: number;
  }): Promise<PageState> {
    this.touch();

    let hoverX: number;
    let hoverY: number;

    if (opts.x !== undefined && opts.y !== undefined) {
      hoverX = opts.x;
      hoverY = opts.y;
    } else if (opts.selector) {
      const coords = await this.evalFn<{ x: number; y: number }>(FIND_BY_SELECTOR, opts.selector);
      if (!coords) throw new Error(`Element not found: ${opts.selector}`);
      hoverX = coords.x;
      hoverY = coords.y;
    } else if (opts.text) {
      const coords = await this.eval<{ x: number; y: number }>(
        `(${FIND_BY_TEXT})(${JSON.stringify(opts.text)}, ${opts.index ?? 0})`,
      );
      if (!coords) throw new Error(`Element not found: ${opts.text}`);
      hoverX = coords.x;
      hoverY = coords.y;
    } else {
      throw new Error('Provide selector, text, or x/y coordinates');
    }

    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: hoverX,
      y: hoverY,
    });

    await new Promise((r) => setTimeout(r, 300));
    if (!this.closed) await this.takeScreenshot();
    const state = await this.getPageState();
    this.notifyUpdate();
    return state;
  }

  async waitForSelector(selector: string, timeout = 10_000): Promise<PageState> {
    this.touch();

    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = await this.eval<boolean>(
        `!!document.querySelector(${JSON.stringify(selector)})`,
      );
      if (found) {
        if (!this.closed) await this.takeScreenshot();
        const state = await this.getPageState();
        this.notifyUpdate();
        return state;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    throw new Error(`Timeout waiting for selector: ${selector}`);
  }

  async scroll(direction: 'up' | 'down', amount = 500): Promise<PageState> {
    this.touch();

    const delta = direction === 'down' ? amount : -amount;
    await this.cdp.send('Runtime.evaluate', {
      expression: `window.scrollBy(0, ${delta})`,
    });

    await new Promise((r) => setTimeout(r, 300));
    if (!this.closed) await this.takeScreenshot();
    const state = await this.getPageState();
    this.notifyUpdate();
    return state;
  }

  async screenshot(opts?: {
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<Buffer> {
    this.touch();
    if (opts?.clip) {
      return this.takeScreenshot({ ...opts.clip, scale: 4 });
    }
    return this.takeScreenshot();
  }

  /** Evaluate arbitrary JS expression in the page and return the result. */
  async evaluate(expression: string): Promise<unknown> {
    this.touch();
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const msg =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'Evaluation failed';
      throw new Error(msg);
    }
    return result.result?.value;
  }

  /** Return raw innerHTML of a selector (or document.body). */
  async getHtml(selector?: string): Promise<string> {
    this.touch();
    const expr = selector
      ? `(document.querySelector(${JSON.stringify(selector)}) || document.body).innerHTML`
      : `document.body.innerHTML`;
    return (await this.eval<string>(expr)) || '';
  }

  async extractContent(selector?: string): Promise<PageContent> {
    this.touch();

    const content = (await this.evalFn<{
      fullText: string;
      links: PageContent['links'];
      forms: PageContent['forms'];
    }>(EXTRACT_CONTENT, selector ?? null)) || { fullText: '', links: [], forms: [] };

    const { url, title } = (await this.eval<{ url: string; title: string }>(URL_AND_TITLE)) || {
      url: '',
      title: '',
    };

    return { url, title, ...content };
  }

  /** Heuristic: find CSS selector for the largest text-containing block element. */
  async findMainContentSelector(): Promise<string | undefined> {
    try {
      return (await this.eval<string>(FIND_MAIN_CONTENT)) || undefined;
    } catch {
      return undefined;
    }
  }

  /** Inject numbered badges on all visible interactive elements and return element metadata. */
  async annotateElements(): Promise<
    Array<{
      index: number;
      tag: string;
      text: string;
      href?: string | null;
      selector?: string | null;
      x: number;
      y: number;
    }>
  > {
    return (await this.eval(ANNOTATE_ELEMENTS)) || [];
  }

  /** Remove the annotation overlay injected by annotateElements(). */
  async removeAnnotations(): Promise<void> {
    await this.eval(REMOVE_ANNOTATIONS).catch(() => {});
  }

  /** Get cookies from the browser for the current page (or a specific URL). */
  async getCookies(urls?: string[]): Promise<
    Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite: string;
    }>
  > {
    this.touch();
    await this.cdp.send('Network.enable');
    const params: Record<string, unknown> = {};
    if (urls && urls.length > 0) {
      params.urls = urls;
    } else if (this.currentUrl && this.currentUrl !== 'about:blank') {
      params.urls = [this.currentUrl];
    }
    const result = await this.cdp.send('Network.getCookies', params);
    return (result.cookies || []).map(
      (c: {
        name: string;
        value: string;
        domain: string;
        path: string;
        expires: number;
        httpOnly: boolean;
        secure: boolean;
        sameSite: string;
      }) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      }),
    );
  }

  /** Set a cookie in the browser. */
  async setCookie(cookie: {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    url?: string;
  }): Promise<boolean> {
    this.touch();
    const params: Record<string, unknown> = {
      name: cookie.name,
      value: cookie.value,
    };
    if (cookie.url) params.url = cookie.url;
    else if (!cookie.domain && this.currentUrl && this.currentUrl !== 'about:blank') {
      params.url = this.currentUrl;
    }
    if (cookie.domain) params.domain = cookie.domain;
    if (cookie.path) params.path = cookie.path;
    if (cookie.expires !== undefined) params.expires = cookie.expires;
    if (cookie.httpOnly !== undefined) params.httpOnly = cookie.httpOnly;
    if (cookie.secure !== undefined) params.secure = cookie.secure;
    if (cookie.sameSite) params.sameSite = cookie.sameSite;
    const result = await this.cdp.send('Network.setCookie', params);
    return result.success !== false;
  }

  /** Delete cookies from the browser. */
  async deleteCookies(opts: {
    name: string;
    domain?: string;
    path?: string;
    url?: string;
  }): Promise<void> {
    this.touch();
    const params: Record<string, unknown> = { name: opts.name };
    if (opts.url) params.url = opts.url;
    else if (!opts.domain && this.currentUrl && this.currentUrl !== 'about:blank') {
      params.url = this.currentUrl;
    }
    if (opts.domain) params.domain = opts.domain;
    if (opts.path) params.path = opts.path;
    await this.cdp.send('Network.deleteCookies', params);
  }

  async extractImages(
    selector?: string,
  ): Promise<
    Array<{ src: string; alt: string; width: number; height: number; dataUrl: string | null }>
  > {
    this.touch();
    const images =
      (await this.evalFn<
        Array<{ src: string; alt: string; width: number; height: number; dataUrl: string | null }>
      >(EXTRACT_IMAGES, selector ?? null)) || [];

    // Server-side fetch fallback for cross-origin images (bypasses CORS)
    return Promise.all(
      images.map(async (img) => {
        if (img.dataUrl || !img.src) return img;
        try {
          const resp = await fetch(img.src, {
            headers: { Referer: this.currentUrl },
          });
          if (!resp.ok) return img;
          const buf = Buffer.from(await resp.arrayBuffer());
          const mime = resp.headers.get('content-type') || 'image/png';
          return { ...img, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
        } catch {
          return img;
        }
      }),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cdp.close();
    this.emit('closed');
    this.removeAllListeners();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
