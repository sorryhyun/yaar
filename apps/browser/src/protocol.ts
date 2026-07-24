/**
 * App Protocol registration for the Browser app.
 * Command handlers use the @bundled/yaar-web SDK for browser automation.
 */
import { app, defineCommand } from '@bundled/yaar';
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
      const result = (await web.open('about:blank', { visible: false })) as { browserId?: string };
      const newId = result?.browserId ?? '0';
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
            'open',
            'click',
            'type',
            'press',
            'scroll',
            'navigate_back',
            'navigate_forward',
            'hover',
            'wait_for',
            'screenshot',
            'extract',
            'extract_images',
            'html',
            'annotate',
            'remove_annotations',
            'refresh',
            'clear',
            'attach',
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
      open: defineCommand({
        description: 'Navigate to URL (auto-creates session if needed)',
        params: {
          type: 'object',
          properties: { url: { type: 'string' }, mobile: { type: 'boolean' } },
          required: ['url'],
        },
        handler: async (p) => {
          return web.open(p.url, { ...(await bid()), mobile: p.mobile, visible: false });
        },
      }),
      navigate_back: defineCommand({
        description: 'Go back in browser history',
        params: { type: 'object', properties: {} },
        handler: async () =>
          web.navigate({ direction: 'back', browserId: (await bid()).browserId }),
      }),
      navigate_forward: defineCommand({
        description: 'Go forward in browser history',
        params: { type: 'object', properties: {} },
        handler: async () =>
          web.navigate({ direction: 'forward', browserId: (await bid()).browserId }),
      }),
      scroll: defineCommand({
        description: 'Scroll the page',
        params: {
          type: 'object',
          properties: {
            direction: { type: 'string', enum: ['up', 'down'] },
            amount: { type: 'number', description: 'Pixels to scroll. Default: one viewport.' },
          },
          required: ['direction'],
        },
        handler: async (p) => web.scroll({ ...p, ...(await bid()) }),
      }),

      // ── Interaction ─────────────────────────────────────────────────
      click: defineCommand({
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
        handler: async (p) => web.click({ ...p, ...(await bid()) }),
      }),
      type: defineCommand({
        description: 'Type text into an element',
        params: {
          type: 'object',
          properties: { selector: { type: 'string' }, text: { type: 'string' } },
          required: ['selector', 'text'],
        },
        handler: async (p) => web.type({ ...p, ...(await bid()) }),
      }),
      press: defineCommand({
        description: 'Press a key',
        params: {
          type: 'object',
          properties: { key: { type: 'string' }, selector: { type: 'string' } },
          required: ['key'],
        },
        handler: async (p) => web.press({ ...p, ...(await bid()) }),
      }),
      hover: defineCommand({
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
        handler: async (p) => web.hover({ ...p, ...(await bid()) }),
      }),

      // ── Observation ─────────────────────────────────────────────────
      wait_for: defineCommand({
        description: 'Wait for a selector to appear',
        params: {
          type: 'object',
          properties: { selector: { type: 'string' }, timeout: { type: 'number' } },
          required: ['selector'],
        },
        handler: async (p) => web.waitFor({ ...p, ...(await bid()) }),
      }),
      screenshot: defineCommand({
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
        handler: async (p) => {
          const result = (await web.screenshot({ ...p, ...(await bid()) })) as {
            ok: boolean;
            text?: string;
            images?: Array<{ data: string; mimeType?: string }>;
          };
          if (!result.ok || !result.images?.length) return result;
          // Return as content blocks so the agent sees the image natively
          return [
            { type: 'text', text: result.text ?? 'Browser screenshot:' },
            ...result.images.map((img) => ({
              type: 'image',
              data: img.data,
              mimeType: img.mimeType ?? 'image/webp',
            })),
          ];
        },
      }),
      extract: defineCommand({
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
        handler: async (p) => web.extract({ ...p, ...(await bid()) }),
      }),
      extract_images: defineCommand({
        description: 'Extract images with data URLs. Filter by size or extension.',
        params: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            mainContentOnly: { type: 'boolean' },
            minWidth: { type: 'number', description: 'Min width in px (default 10)' },
            minHeight: { type: 'number', description: 'Min height in px (default 10)' },
            extensions: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by file extension, e.g. ["jpg","png"]',
            },
          },
        },
        handler: async (p) => web.extractImages({ ...p, ...(await bid()) }),
      }),
      html: defineCommand({
        // The handler spreads the whole bag into web.html, so every option the SDK
        // accepts has to be declared here or it is rejected as an unknown param —
        // and includeMeta is the only way to learn which URL the HTML came from.
        description:
          'Get page HTML. Default is document.body.innerHTML — a FRAGMENT: no doctype, no ' +
          '<head>, no <title>. Use includeMeta to get the source URL and title.',
        params: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            outerHTML: {
              type: 'boolean',
              description: "Include the element's own tag. With no selector, the whole <html>.",
            },
            includeMeta: {
              type: 'boolean',
              description: 'Return JSON { html, url, title, readyState } instead of a bare string.',
            },
          },
        },
        handler: async (p) => web.html({ ...p, ...(await bid()) }),
      }),

      // ── Visual ──────────────────────────────────────────────────────
      annotate: defineCommand({
        description: 'Show numbered badges on interactive elements',
        params: { type: 'object', properties: {} },
        handler: async () => web.annotate((await bid()).browserId),
      }),
      remove_annotations: defineCommand({
        description: 'Remove annotation badges',
        params: { type: 'object', properties: {} },
        handler: async () => web.removeAnnotations((await bid()).browserId),
      }),

      // ── UI Controls (local, no verb call) ───────────────────────────
      refresh: defineCommand({
        description: 'Refresh screenshot and optionally update URL bar',
        params: {
          type: 'object',
          properties: { url: { type: 'string' }, title: { type: 'string' } },
        },
        handler: (p) => {
          if (p?.url) deps.updateUrlBar(p.url, p.title);
          deps.refreshScreenshot();
          return { currentUrl: deps.getCurrentUrl() };
        },
      }),
      clear: defineCommand({
        description: 'Clear the browser display',
        params: { type: 'object', properties: {} },
        handler: () => {
          deps.clearDisplay();
        },
      }),
      attach: defineCommand({
        description: 'Switch to a different browser by ID',
        params: {
          type: 'object',
          properties: { browserId: { type: 'string' } },
          required: ['browserId'],
        },
        handler: (p) => {
          deps.attach(p.browserId);
          return { browserId: p.browserId };
        },
      }),
    },
  });
}
