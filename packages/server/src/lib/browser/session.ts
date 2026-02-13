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

  private async getPageState(): Promise<PageState> {
    const evalResult = await this.cdp.send('Runtime.evaluate', {
      expression: '({url: location.href, title: document.title})',
      returnByValue: true,
    });

    const { url, title } = evalResult.result?.value || {
      url: this.currentUrl,
      title: '',
    };
    this.currentUrl = url;
    this.currentTitle = title;

    let textSnippet = '';
    try {
      const textResult = await this.cdp.send('Runtime.evaluate', {
        expression: '(document.body?.innerText || "").trim()',
        returnByValue: true,
      });
      textSnippet = textResult.result?.value || '';
      if (textSnippet.length > TEXT_SNIPPET_LENGTH) {
        textSnippet = textSnippet.slice(0, TEXT_SNIPPET_LENGTH) + '...';
      }
    } catch {
      /* page not ready */
    }

    return { url, title, textSnippet };
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

    // Find element coordinates via JS evaluation
    const findBySelector = `function(sel) {
      var el = document.querySelector(sel);
      if (!el) return null;
      if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded();
      else el.scrollIntoView({block:'center'});
      var rect = el.getBoundingClientRect();
      return {x: rect.x + rect.width/2, y: rect.y + rect.height/2};
    }`;

    const findByText = `function(txt) {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      var node;
      while (node = walker.nextNode()) {
        if (node.textContent && node.textContent.trim().includes(txt)) {
          var el = node.parentElement;
          if (el) {
            if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded();
            else el.scrollIntoView({block:'center'});
            var rect = el.getBoundingClientRect();
            return {x: rect.x + rect.width/2, y: rect.y + rect.height/2};
          }
        }
      }
      return null;
    }`;

    const fn = selector ? findBySelector : findByText;
    const arg = selector || text;

    const coordsResult = await this.cdp.send('Runtime.evaluate', {
      expression: `(${fn})(${JSON.stringify(arg)})`,
      returnByValue: true,
    });

    const coords = coordsResult.result?.value;
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
    this.notifyUpdate();
    return state;
  }

  async type(selector: string, text: string): Promise<PageState> {
    this.touch();

    // Focus and clear the input
    await this.cdp.send('Runtime.evaluate', {
      expression: `(function(sel) {
        var el = document.querySelector(sel);
        if (!el) throw new Error('Element not found: ' + sel);
        el.focus();
        el.value = '';
        el.dispatchEvent(new Event('input', {bubbles: true}));
      })(${JSON.stringify(selector)})`,
    });

    // Insert text
    await this.cdp.send('Input.insertText', { text });

    // Fire change events
    await this.cdp.send('Runtime.evaluate', {
      expression: `(function(sel) {
        var el = document.querySelector(sel);
        if (el) {
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
        }
      })(${JSON.stringify(selector)})`,
    });

    if (!this.closed) await this.takeScreenshot();
    const state = await this.getPageState();
    this.notifyUpdate();
    return state;
  }

  async press(key: string): Promise<PageState> {
    this.touch();

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

    const fn = `function(sel) {
      var root = sel ? document.querySelector(sel) : document.body;
      if (!root) return {fullText: '', links: [], forms: []};

      var fullText = root.innerText || '';

      var links = [];
      var anchors = root.querySelectorAll('a[href]');
      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        var text = (a.textContent || '').trim();
        var href = a.getAttribute('href') || '';
        if (text && href) links.push({text: text, href: href});
      }

      var forms = [];
      var formEls = root.querySelectorAll('form');
      for (var j = 0; j < formEls.length; j++) {
        var form = formEls[j];
        var fields = [];
        var inputs = form.querySelectorAll('input, select, textarea');
        for (var k = 0; k < inputs.length; k++) {
          var inp = inputs[k];
          fields.push({
            name: inp.name || inp.id || '',
            type: inp.type || inp.tagName.toLowerCase(),
            value: inp.value || undefined
          });
        }
        forms.push({action: form.getAttribute('action') || '', fields: fields});
      }

      return {fullText: fullText, links: links, forms: forms};
    }`;

    const evalResult = await this.cdp.send('Runtime.evaluate', {
      expression: `(${fn})(${JSON.stringify(selector ?? null)})`,
      returnByValue: true,
    });

    const urlResult = await this.cdp.send('Runtime.evaluate', {
      expression: '({url: location.href, title: document.title})',
      returnByValue: true,
    });

    const { url, title } = urlResult.result?.value || { url: '', title: '' };
    const result = evalResult.result?.value || { fullText: '', links: [], forms: [] };

    return { url, title, ...result };
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
