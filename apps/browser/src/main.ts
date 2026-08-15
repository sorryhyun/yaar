import { onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { defineApp } from '@bundled/yaar';
import * as web from '@bundled/yaar-web';
import {
  lock, loading, showScreenshot, placeholderText, currentUrl, pageTitle,
  activeBrowserId, setActiveBrowserId,
  initialBrowserId,
  updateUrlBar, resetDisplay, clearDisplay,
} from './store';
import { connectSSE, disconnectSSE, initSSE } from './sse';
import {
  refreshScreenshot, setScreenshotEl,
  handleNav, handleReload, handleUrlFocus, handleUrlKeydown,
} from './actions';
import './styles.css';

// Inject refreshScreenshot into SSE module before first connectSSE() call
initSSE(refreshScreenshot);

/**
 * Attach to a different browser at runtime.
 * Orchestrates store + SSE together (defined here to avoid circular deps).
 */
function attach(browserId: string): void {
  setActiveBrowserId(browserId);
  resetDisplay('Connecting...');
  connectSSE(browserId);
}

connectSSE(initialBrowserId);
onCleanup(() => disconnectSSE());

/** Promise lock to prevent double-creation of browser sessions. */
let creatingSession: Promise<string> | null = null;

/**
 * Ensure we have a valid browserId. If none is set (e.g. app opened without
 * ?browserId), lazily create a session via the verb layer with visible:false
 * to avoid opening a duplicate window.
 */
async function ensureBrowserId(): Promise<string> {
  const current = activeBrowserId();
  if (current && current !== '' && current !== 'new') return current;

  if (creatingSession) return creatingSession;

  creatingSession = (async () => {
    const result = (await web.open('about:blank', { visible: false })) as { browserId?: string };
    const newId = result?.browserId ?? '0';
    setActiveBrowserId(newId);
    connectSSE(newId);
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

function App() {
  return html`
    <div class="browser-chrome y-app">
      <div class="url-bar y-flex y-gap-2 y-px-2 y-surface y-border-b">
        <button class="y-btn y-btn-sm y-btn-ghost" title="Back" aria-label="Back"
          onClick=${() => handleNav('navigate_back')}>←</button>
        <button class="y-btn y-btn-sm y-btn-ghost" title="Forward" aria-label="Forward"
          onClick=${() => handleNav('navigate_forward')}>→</button>
        <span class=${() => lock().cls}>${() => lock().icon}</span>
        <input class="url-text y-input"
          value=${() => currentUrl()}
          onFocus=${handleUrlFocus}
          onKeydown=${handleUrlKeydown} />
        <button class="y-btn y-btn-sm y-btn-ghost" title="Reload" aria-label="Reload"
          onClick=${handleReload}>↻</button>
        <span class="title-text y-text-xs y-text-muted y-truncate">${() => pageTitle()}</span>
      </div>
      <div class="screenshot-area">
        <div class=${() => loading() ? 'loading-bar active' : 'loading-bar'}></div>
        ${() => !showScreenshot() ? html`
          <div class="placeholder y-text-muted y-text-sm">${() => placeholderText()}</div>
        ` : null}
        <img
          ref=${(el: HTMLImageElement) => { setScreenshotEl(el); }}
          style=${() => showScreenshot() ? '' : 'display:none'}
          alt="Browser screenshot" />
      </div>
    </div>
  `;
}

export default defineApp({
  id: 'browser',
  name: 'Browser',
  state: {
    currentUrl: {
      description: 'Currently displayed URL',
      get: () => currentUrl(),
    },
    pageTitle: {
      description: 'Current page title',
      get: () => pageTitle(),
    },
    browserId: {
      description: 'Currently connected browser ID',
      get: () => activeBrowserId(),
    },
  },
  commands: {
    open: {
      description: 'Navigate to URL (auto-creates session if needed)',
      params: {
        type: 'object',
        properties: { url: { type: 'string' }, mobile: { type: 'boolean' } },
        required: ['url'],
      },
      run: async (p) => {
        return web.open(p.url, { ...(await bid()), mobile: p.mobile, visible: false });
      },
    },
    navigate_back: {
      description: 'Go back in browser history',
      params: { type: 'object', properties: {} },
      run: async () => web.navigate({ direction: 'back', browserId: (await bid()).browserId }),
    },
    navigate_forward: {
      description: 'Go forward in browser history',
      params: { type: 'object', properties: {} },
      run: async () => web.navigate({ direction: 'forward', browserId: (await bid()).browserId }),
    },
    scroll: {
      description: 'Scroll the page',
      params: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'] },
          amount: { type: 'number', description: 'Pixels to scroll. Default: one viewport.' },
        },
        required: ['direction'],
      },
      run: async (p) => web.scroll({ ...p, ...(await bid()) }),
    },

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
      run: async (p) => web.click({ ...p, ...(await bid()) }),
    },
    type: {
      description: 'Type text into an element',
      params: {
        type: 'object',
        properties: { selector: { type: 'string' }, text: { type: 'string' } },
        required: ['selector', 'text'],
      },
      run: async (p) => web.type({ ...p, ...(await bid()) }),
    },
    press: {
      description: 'Press a key',
      params: {
        type: 'object',
        properties: { key: { type: 'string' }, selector: { type: 'string' } },
        required: ['key'],
      },
      run: async (p) => web.press({ ...p, ...(await bid()) }),
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
      run: async (p) => web.hover({ ...p, ...(await bid()) }),
    },

    wait_for: {
      description: 'Wait for a selector to appear',
      params: {
        type: 'object',
        properties: { selector: { type: 'string' }, timeout: { type: 'number' } },
        required: ['selector'],
      },
      run: async (p) => web.waitFor({ ...p, ...(await bid()) }),
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
      run: async (p) => {
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
      run: async (p) => web.extract({ ...p, ...(await bid()) }),
    },
    extract_images: {
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
      run: async (p) => web.extractImages({ ...p, ...(await bid()) }),
    },
    html: {
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
      run: async (p) => web.html({ ...p, ...(await bid()) }),
    },

    annotate: {
      description: 'Show numbered badges on interactive elements',
      params: { type: 'object', properties: {} },
      run: async () => web.annotate((await bid()).browserId),
    },
    remove_annotations: {
      description: 'Remove annotation badges',
      params: { type: 'object', properties: {} },
      run: async () => web.removeAnnotations((await bid()).browserId),
    },

    // UI controls: local, no verb call.
    refresh: {
      description: 'Refresh screenshot and optionally update URL bar',
      params: {
        type: 'object',
        properties: { url: { type: 'string' }, title: { type: 'string' } },
      },
      run: (p) => {
        if (p?.url) updateUrlBar(p.url, p.title);
        refreshScreenshot();
        return { currentUrl: currentUrl() };
      },
    },
    clear: {
      description: 'Clear the browser display',
      params: { type: 'object', properties: {} },
      run: () => {
        clearDisplay();
      },
    },
    attach: {
      description: 'Switch to a different browser by ID',
      params: {
        type: 'object',
        properties: { browserId: { type: 'string' } },
        required: ['browserId'],
      },
      run: (p) => {
        attach(p.browserId);
        return { browserId: p.browserId };
      },
    },
  },
  view: App,
});
