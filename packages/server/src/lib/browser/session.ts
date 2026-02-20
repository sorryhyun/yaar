/**
 * BrowserSession — wraps one Chrome tab via CDP.
 *
 * Each session tracks its bound YAAR window, current URL, and latest screenshot.
 * Screenshots are stored in memory as JPEG buffers and served via HTTP.
 *
 * Emits 'updated' events after each state change so listeners (SSE, etc.)
 * can push live updates to the browser app iframe.
 */

import { EventEmitter } from 'events';
import { CDPClient } from './cdp.js';
import type { PageState, PageContent } from './types.js';
import {
  PAGE_STATE,
  BODY_TEXT,
  URL_AND_TITLE,
  FIND_BY_SELECTOR,
  FIND_BY_TEXT,
  FOCUS_AND_CLEAR,
  FIRE_CHANGE_EVENTS,
  EXTRACT_CONTENT,
  FIND_MAIN_CONTENT,
} from './page-scripts.js';

const SCREENSHOT_WIDTH = 1280;
const SCREENSHOT_HEIGHT = 800;
const SCREENSHOT_QUALITY = 80;
const TEXT_SNIPPET_LENGTH = 500;

export interface BrowserSessionUpdate {
  url: string;
  title: string;
  version: number;
}

export class BrowserSession extends EventEmitter {
  readonly id: string;
  windowId: string | undefined;
  currentUrl = 'about:blank';
  currentTitle = '';
  lastScreenshot: Buffer | null = null;
  lastActivity = Date.now();
  version = 0;

  private cdp: CDPClient;
  private closed = false;

  private constructor(id: string, cdp: CDPClient) {
    super();
    this.id = id;
    this.cdp = cdp;
  }

  static async create(id: string, debuggerUrl: string): Promise<BrowserSession> {
    const cdp = await CDPClient.connect(debuggerUrl);
    const session = new BrowserSession(id, cdp);

    // Enable required CDP domains
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Set viewport
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: SCREENSHOT_WIDTH,
      height: SCREENSHOT_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Set user agent
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
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

  private async takeScreenshot(): Promise<Buffer> {
    const result = await this.cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: SCREENSHOT_QUALITY,
    });
    this.lastScreenshot = Buffer.from(result.data, 'base64');
    return this.lastScreenshot;
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
    const { url, title, activeElement } = (await this.eval<{
      url: string;
      title: string;
      activeElement: PageState['activeElement'] | null;
    }>(PAGE_STATE)) || { url: this.currentUrl, title: '', activeElement: null };

    this.currentUrl = url;
    this.currentTitle = title;

    let textSnippet = '';
    try {
      textSnippet = (await this.eval<string>(BODY_TEXT)) || '';
      if (textSnippet.length > TEXT_SNIPPET_LENGTH) {
        textSnippet = textSnippet.slice(0, TEXT_SNIPPET_LENGTH) + '...';
      }
    } catch {
      /* page not ready */
    }

    const state: PageState = { url, title, textSnippet };
    if (activeElement) state.activeElement = activeElement;
    return state;
  }

  async navigate(url: string): Promise<PageState> {
    this.touch();

    // Start navigation and wait for load
    const loadPromise = this.cdp.waitForEvent('Page.loadEventFired', 30_000);
    await this.cdp.send('Page.navigate', { url });
    await loadPromise.catch(() => {}); // timeout is non-fatal

    // Small delay for dynamic content
    await new Promise((r) => setTimeout(r, 500));

    if (!this.closed) await this.takeScreenshot();
    const state = await this.getPageState();
    this.notifyUpdate();
    return state;
  }

  async click(selector?: string, text?: string): Promise<PageState> {
    this.touch();

    if (!selector && !text) {
      throw new Error('Either selector or text must be provided');
    }

    const urlBefore = this.currentUrl;

    const fn = selector ? FIND_BY_SELECTOR : FIND_BY_TEXT;
    const arg = selector || text;
    const coords = await this.evalFn<{
      x: number;
      y: number;
      tag: string;
      text: string;
      candidateCount: number;
    }>(fn, arg);

    if (!coords) {
      throw new Error(`Element not found: ${selector || text}`);
    }

    // Dispatch mouse click
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

    // Wait for potential navigation or re-render
    await new Promise((r) => setTimeout(r, 500));

    if (!this.closed) await this.takeScreenshot();
    const state = await this.getPageState();
    state.urlChanged = state.url !== urlBefore;
    state.clickTarget = {
      tag: coords.tag,
      text: coords.text,
      candidateCount: coords.candidateCount,
    };
    this.notifyUpdate();
    return state;
  }

  async type(selector: string, text: string): Promise<PageState> {
    this.touch();
    const urlBefore = this.currentUrl;

    // Focus and clear the input
    await this.evalFn(FOCUS_AND_CLEAR, selector);

    // Insert text
    await this.cdp.send('Input.insertText', { text });

    // Fire change events
    await this.evalFn(FIRE_CHANGE_EVENTS, selector);

    if (!this.closed) await this.takeScreenshot();
    const state = await this.getPageState();
    state.urlChanged = state.url !== urlBefore;
    this.notifyUpdate();
    return state;
  }

  async press(key: string): Promise<PageState> {
    this.touch();
    const urlBefore = this.currentUrl;

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

    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: desc.key,
      code: desc.code,
      windowsVirtualKeyCode: desc.keyCode,
      nativeVirtualKeyCode: desc.keyCode,
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

  async screenshot(): Promise<Buffer> {
    this.touch();
    return this.takeScreenshot();
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
