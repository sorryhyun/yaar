/**
 * App Protocol registration for the Browser app.
 * Command handlers use the @bundled/yaar-web SDK for browser automation.
 */
import { app, invoke } from '@bundled/yaar';
import * as web from '@bundled/yaar-web';

export interface BrowserProtocolDeps {
  getCurrentUrl: () => string;
  getPageTitle: () => string;
  getActiveBrowserId: () => string;
  setActiveBrowserId: (id: string) => void;
  updateUrlBar: (url: string, title?: string) => void;
  refreshScreenshot: () => void;
  clearDisplay: () => void;
  attach: (browserId: string) => void;
}

/** Promise lock to prevent double-creation of browser sessions. */
let creatingSession: Promise<string> | null = null;

export function registerBrowserProtocol(deps: BrowserProtocolDeps): void {
  if (!app) return;

  /**
   * Ensure we have a valid browserId. If none is set (e.g. app opened without
   * ?browserId), lazily create a session via the verb layer with visible:false
   * to avoid opening a duplicate window.
   */
  async function ensureBrowserId(): Promise<string> {
    const current = deps.getActiveBrowserId();
    if (current && current !== '' && current !== 'new') return current;

    if (creatingSession) return creatingSession;

    creatingSession = (async () => {
      const result = await invoke<{ browserId: string }>('yaar://browser/new', {
        action: 'open',
        url: 'about:blank',
        visible: false,
      });
      const newId = result.browserId ?? '0';
      deps.setActiveBrowserId(newId);
      return newId;
    })();

    try {
      return await creatingSession;
    } finally {
      creatingSession = null;
    }
  }

  /** Get browserId option for yaar-web calls. */
  async function bid() {
    return { browserId: await ensureBrowserId() };
  }

  app.register({
    appId: 'browser',
    name: 'Browser',
    state: {
      manifest: {
        description: 'App capabilities',
        handler: () => ({
          state: ['currentUrl', 'pageTitle', 'browserId'],
          commands: [
            'open', 'click', 'type', 'press', 'scroll',
            'navigate_back', 'navigate_forward', 'hover', 'wait_for',
            'screenshot', 'extract', 'extract_images', 'html',
            'annotate', 'remove_annotations',
            'refresh', 'clear', 'attach',
          ],
        }),
      },
      currentUrl: {
        description: 'Currently displayed URL',
        handler: () => deps.getCurrentUrl(),
      },
      pageTitle: {
        description: 'Current page title',
        handler: () => deps.getPageTitle(),
      },
      browserId: {
        description: 'Currently connected browser ID',
        handler: () => deps.getActiveBrowserId(),
      },
    },
    commands: {
      // ── Navigation ──────────────────────────────────────────────────
      open: {
        description: 'Navigate to URL (auto-creates session if needed)',
        params: {
          type: 'object',
          properties: { url: { type: 'string' }, mobile: { type: 'boolean' } },
          required: ['url'],
        },
        handler: async (p: { url: string; mobile?: boolean }) => {
          return web.open(p.url, { ...await bid(), mobile: p.mobile, visible: false });
        },
      },
      navigate_back: {
        description: 'Go back in browser history',
        params: { type: 'object', properties: {} },
        handler: async () => web.navigateBack((await bid()).browserId),
      },
      navigate_forward: {
        description: 'Go forward in browser history',
        params: { type: 'object', properties: {} },
        handler: async () => web.navigateForward((await bid()).browserId),
      },
      scroll: {
        description: 'Scroll the page',
        params: {
          type: 'object',
          properties: { direction: { type: 'string', enum: ['up', 'down'] } },
          required: ['direction'],
        },
        handler: async (p: { direction: 'up' | 'down' }) =>
          web.scroll({ ...p, ...await bid() }),
      },

      // ── Interaction ─────────────────────────────────────────────────
      click: {
        description: 'Click an element',
        params: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            text: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
            index: { type: 'number' },
          },
        },
        handler: async (p: {
          selector?: string;
          text?: string;
          x?: number;
          y?: number;
          index?: number;
        }) => web.click({ ...p, ...await bid() }),
      },
      type: {
        description: 'Type text into an element',
        params: {
          type: 'object',
          properties: { selector: { type: 'string' }, text: { type: 'string' } },
          required: ['selector', 'text'],
        },
        handler: async (p: { selector: string; text: string }) =>
          web.type({ ...p, ...await bid() }),
      },
      press: {
        description: 'Press a key',
        params: {
          type: 'object',
          properties: { key: { type: 'string' }, selector: { type: 'string' } },
          required: ['key'],
        },
        handler: async (p: { key: string; selector?: string }) =>
          web.press({ ...p, ...await bid() }),
      },
      hover: {
        description: 'Hover over an element',
        params: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            text: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
          },
        },
        handler: async (p: {
          selector?: string;
          text?: string;
          x?: number;
          y?: number;
        }) => web.hover({ ...p, ...await bid() }),
      },

      // ── Observation ─────────────────────────────────────────────────
      wait_for: {
        description: 'Wait for a selector to appear',
        params: {
          type: 'object',
          properties: { selector: { type: 'string' }, timeout: { type: 'number' } },
          required: ['selector'],
        },
        handler: async (p: { selector: string; timeout?: number }) =>
          web.waitFor({ ...p, ...await bid() }),
      },
      screenshot: {
        description: 'Take a screenshot',
        params: {
          type: 'object',
          properties: {
            x0: { type: 'number' },
            y0: { type: 'number' },
            x1: { type: 'number' },
            y1: { type: 'number' },
          },
        },
        handler: async (p?: {
          x0?: number;
          y0?: number;
          x1?: number;
          y1?: number;
        }) => web.screenshot({ ...p, ...await bid() }),
      },
      extract: {
        description: 'Extract page text, links, and forms',
        params: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            mainContentOnly: { type: 'boolean' },
            maxTextLength: { type: 'number' },
            maxLinks: { type: 'number' },
          },
        },
        handler: async (p?: {
          selector?: string;
          mainContentOnly?: boolean;
          maxTextLength?: number;
          maxLinks?: number;
        }) => web.extract({ ...p, ...await bid() }),
      },
      extract_images: {
        description: 'Extract images with data URLs',
        params: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            mainContentOnly: { type: 'boolean' },
          },
        },
        handler: async (p?: { selector?: string; mainContentOnly?: boolean }) =>
          web.extractImages({ ...p, ...await bid() }),
      },
      html: {
        description: 'Get raw innerHTML',
        params: {
          type: 'object',
          properties: { selector: { type: 'string' } },
        },
        handler: async (p?: { selector?: string }) =>
          web.html({ ...p, ...await bid() }),
      },

      // ── Visual ──────────────────────────────────────────────────────
      annotate: {
        description: 'Show numbered badges on interactive elements',
        params: { type: 'object', properties: {} },
        handler: async () => web.annotate((await bid()).browserId),
      },
      remove_annotations: {
        description: 'Remove annotation badges',
        params: { type: 'object', properties: {} },
        handler: async () => web.removeAnnotations((await bid()).browserId),
      },

      // ── UI Controls (local, no verb call) ───────────────────────────
      refresh: {
        description: 'Refresh screenshot and optionally update URL bar',
        params: {
          type: 'object',
          properties: { url: { type: 'string' }, title: { type: 'string' } },
        },
        handler: (p?: { url?: string; title?: string }) => {
          if (p?.url) deps.updateUrlBar(p.url, p.title);
          deps.refreshScreenshot();
          return { ok: true, currentUrl: deps.getCurrentUrl() };
        },
      },
      clear: {
        description: 'Clear the browser display',
        params: { type: 'object', properties: {} },
        handler: () => {
          deps.clearDisplay();
          return { ok: true };
        },
      },
      attach: {
        description: 'Switch to a different browser by ID',
        params: {
          type: 'object',
          properties: { browserId: { type: 'string' } },
          required: ['browserId'],
        },
        handler: (p: { browserId: string }) => {
          deps.attach(p.browserId);
          return { ok: true, browserId: p.browserId };
        },
      },
    },
  });
}
