/**
 * The Real Browser app: a live view of the user's real Chrome tabs, plus the App
 * Protocol surface that lets a monitor agent observe AND drive them via the YAAR
 * Bridge extension.
 *
 * Protocol shape (see the `defineApp` call at the bottom of this file):
 *   - `state`:   tabs / activeTab / connected
 *   - `commands`
 *       manage:  focus / close / group / move / track / refresh
 *       read:    extract (page text) / screenshot (WebP image of the visible tab)
 *       drive:   click / type / scroll / navigate (synthetic DOM events over the Bridge)
 * Every command delegates to the matching `./bridge.ts` helper and unwraps its envelope, so the
 * agent receives the bare payload (e.g. the extracted `{ url, title, text }`) instead of a
 * `{ ok, data }` wrapper. Consent refusals / failures throw, which the App Protocol surfaces to
 * the agent as a clean command error. The drive/read verbs are gated per-origin on the server
 * (tab-control consent for click/type/scroll/navigate, content-read for extract/screenshot) — the
 * user's "Allow use" button pre-grants both, so a granted tab drives without further prompts.
 */
import { For, Show, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { defineApp, errMsg, wait } from '@bundled/yaar';
import * as bridge from './bridge';
import type { Tab } from './bridge';
import { tabs, connected, loaded, activeTab, pollOnce } from './store';

const POLL_INTERVAL_MS = 1200;

// Initial load + live polling of the real tab feed.
pollOnce();
const timer = setInterval(() => pollOnce(), POLL_INTERVAL_MS);
onCleanup(() => clearInterval(timer));

function faviconHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Fire a Bridge action at a tab. Server-side guards handle consent / self-target refusal. */
async function act(tab: Tab, action: 'close' | 'allow') {
  try {
    if (action === 'close') await bridge.close(tab.id);
    else await bridge.allow(tab.id);
    // Trigger an immediate refresh so the list reflects the change without waiting a full tick.
    pollOnce();
  } catch (err) {
    console.error(`[real-tabs] ${action} failed`, err);
  }
}

function TabRow(tab: Tab) {
  // Handlers bound once here (outside the reactive template) — Solid re-fires event props
  // passed reactively, so keep these stable per row.
  const onAllow = () => act(tab, 'allow');
  const onClose = () => act(tab, 'close');
  return html`
    <div class="y-list-item" style="display:flex; align-items:center; gap:var(--yaar-sp-2);">
      <div style="flex:1; min-width:0;">
        <div class="y-truncate" style="font-weight:500;">${() => tab.title || '(untitled)'}</div>
        <div class="y-truncate" style="color:var(--yaar-text-muted); font-size:0.85em;">
          ${() => faviconHost(tab.url) || tab.url}
        </div>
      </div>
      ${() => (tab.active ? html`<span class="y-badge">active</span>` : null)}
      ${() => (tab.audible ? html`<span class="y-badge">🔊</span>` : null)}
      ${() => (tab.isSelf ? html`<span class="y-badge">self</span>` : null)}
      <div class="y-flex" style="gap:var(--yaar-sp-1); flex:0 0 auto;">
        ${() =>
          tab.isSelf
            ? null
            : tab.allowed
              ? html`<span
                  class="y-badge"
                  style="background:var(--yaar-success);"
                  title="The agent can view, scroll, click, and read this tab"
                  >in use</span
                >`
              : html`<button
                  class="y-btn y-btn-primary"
                  title="Let the agent view, scroll, click, and read this tab"
                  onClick=${onAllow}
                >
                  Allow use
                </button>`}
        ${() =>
          tab.isSelf
            ? null
            : html`<button class="y-btn y-btn-danger" title="Close this tab" onClick=${onClose}>
                ✕
              </button>`}
      </div>
    </div>
  `;
}

function App() {
  return html`
    <div class="y-app" style="position:absolute; inset:0; display:flex; flex-direction:column;">
      <div
        class="y-toolbar"
        style="display:flex; align-items:center; justify-content:space-between;"
      >
        <span class="y-label">Real Tabs</span>
        <span
          class="y-badge"
          style=${() =>
            connected()
              ? 'background:var(--yaar-success);'
              : 'background:var(--yaar-border); color:var(--yaar-text-muted);'}
        >
          ${() => (connected() ? `bridge · ${tabs().length}` : 'disconnected')}
        </span>
      </div>

      <div style="flex:1; overflow:auto; padding:var(--yaar-sp-2);">
        <${Show}
          when=${() => loaded()}
          fallback=${html`<div class="y-empty">
            <div class="y-empty-icon">⏳</div>
            Loading…
          </div>`}
        >
          <${Show}
            when=${() => connected() && tabs().length > 0}
            fallback=${html`
              <div class="y-empty">
                <div class="y-empty-icon">🔌</div>
                YAAR Bridge not connected. Load the extension (see
                <code>extension/README.md</code>) and it'll appear here live.
              </div>
            `}
          >
            <${For} each=${() => tabs()}>${(tab: Tab) => TabRow(tab)}<//>
          <//>
        <//>
      </div>
    </div>
  `;
}

// ── App Protocol ─────────────────────────────────────────────────────────

/**
 * Unwrap a Bridge envelope for an app command: return its `data` on success,
 * or throw its `error` so the App Protocol reports a proper command failure
 * (rather than stringifying a `{ ok: false, error }` object as a "successful" result).
 */
async function unwrap<T>(p: Promise<bridge.BridgeEnvelope<T>>): Promise<T> {
  const res = await p;
  if (!res.ok) throw new Error(res.error || 'Bridge command failed.');
  return res.data as T;
}

/** MCP content blocks a command handler can return; image blocks are shown to the agent via vision. */
type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** Turn a screenshot payload into a caption + image content block (throws if it carries no image). */
function shotToBlocks(shot: bridge.ScreenshotData, caption: string): Block[] {
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(shot.dataUrl || '');
  if (!m) throw new Error('Screenshot returned no image data.');
  return [
    { type: 'text', text: caption },
    { type: 'image', data: m[2], mimeType: m[1] },
  ];
}

/** How long to let the page settle (paint + async DOM updates) before a post-action screenshot. */
const SETTLE_MS = 400;

/**
 * Run a drive verb, then — when the caller passes `screenshot: true` — snapshot the tab so the agent
 * sees the result of its action in the SAME turn, instead of a separate focus+screenshot round trip.
 * The shot is best-effort: the drive already succeeded, so if the capture fails (tab not focused,
 * content consent declined) we return the drive summary with a short note rather than erroring out.
 */
async function withOptionalShot(
  tabId: number,
  wantShot: boolean | undefined,
  driveResult: unknown,
): Promise<unknown> {
  if (!wantShot) return driveResult;
  const summary =
    typeof driveResult === 'string' ? driveResult : JSON.stringify(driveResult ?? { ok: true });
  await wait(SETTLE_MS);
  try {
    return shotToBlocks(await unwrap(bridge.screenshot(tabId)), summary);
  } catch (e) {
    return [
      { type: 'text', text: `${summary}\n(screenshot unavailable: ${errMsg(e)})` },
    ] satisfies Block[];
  }
}

export default defineApp({
  id: 'browser-user',
  name: 'Real Browser',
  events: {
    dialog: {
      description:
        'A native alert/confirm/prompt fired on a driven tab. Payload: { kind, message, tabId? }.',
    },
    navigated: {
      description: 'A driven tab finished loading a new URL. Payload: { tabId, url, title? }.',
    },
  },
  state: {
    tabs: {
      description:
        "The user's real Chrome tabs (id, url, title, active, audible, isSelf, allowed). " +
        '`allowed` is true once the user has granted full agent use of that tab (via its "Allow use" button).',
      get: () => [...tabs()],
    },
    activeTab: {
      description: 'The currently active real tab, or null if none/disconnected',
      get: () => activeTab(),
    },
    connected: {
      description: 'Whether the YAAR Bridge extension is connected',
      get: () => connected(),
    },
  },
  commands: {
    focus: {
      description: 'Focus (activate) a real browser tab by its id',
      params: {
        type: 'object',
        properties: { tabId: { type: 'number' } },
        required: ['tabId'],
      },
      run: (p) => unwrap(bridge.focus(p.tabId)),
    },
    close: {
      description:
        "Close a real browser tab. Refused for YAAR's own tab; may prompt per-origin consent for logged-in sites.",
      params: {
        type: 'object',
        properties: { tabId: { type: 'number' } },
        required: ['tabId'],
      },
      run: (p) => unwrap(bridge.close(p.tabId)),
    },
    group: {
      description:
        'Group real browser tabs together, optionally under a title. May prompt per-origin consent.',
      params: {
        type: 'object',
        properties: {
          tabId: { type: 'number' },
          tabIds: { type: 'array', items: { type: 'number' } },
          groupTitle: { type: 'string' },
        },
        required: ['tabId'],
      },
      run: (p) => unwrap(bridge.group(p.tabId, p.tabIds, p.groupTitle)),
    },
    move: {
      description:
        'Move a real browser tab to a new index and/or window. May prompt per-origin consent.',
      params: {
        type: 'object',
        properties: {
          tabId: { type: 'number' },
          index: { type: 'number' },
          windowId: { type: 'number' },
        },
        required: ['tabId'],
      },
      run: (p) => unwrap(bridge.move(p.tabId, p.index, p.windowId)),
    },
    track: {
      description: 'Show a tracking cursor / highlight on a real browser tab',
      params: {
        type: 'object',
        properties: { tabId: { type: 'number' } },
        required: ['tabId'],
      },
      run: (p) => unwrap(bridge.track(p.tabId)),
    },
    extract: {
      description:
        'Extract the visible page text from a real browser tab. May prompt per-origin consent. maxChars caps the returned text.',
      params: {
        type: 'object',
        properties: {
          tabId: { type: 'number' },
          maxChars: { type: 'number' },
        },
        required: ['tabId'],
      },
      run: (p) => unwrap(bridge.extract(p.tabId, p.maxChars)),
    },
    screenshot: {
      description:
        'Capture a WebP screenshot of a real tab and return it as an image the agent can see. ' +
        'The tab must be focused first (see `focus`). May prompt per-origin content consent.',
      params: {
        type: 'object',
        properties: { tabId: { type: 'number' } },
        required: ['tabId'],
      },
      // Return an MCP image content block (not the raw data-URL object) so the agent actually
      // *sees* the pixels via vision, instead of receiving a giant opaque base64 string as text.
      run: async (p) => {
        const shot = await unwrap(bridge.screenshot(p.tabId));
        return shotToBlocks(shot, `Screenshot of "${shot.title}" — ${shot.url}`);
      },
    },
    click: {
      description:
        'Click the element matching a CSS selector in a real tab. Set screenshot=true to get an ' +
        'image of the resulting page back (best-effort; the tab must be focused). May prompt ' +
        'per-origin tab-control consent.',
      params: {
        type: 'object',
        properties: {
          tabId: { type: 'number' },
          selector: { type: 'string' },
          screenshot: { type: 'boolean' },
        },
        required: ['tabId', 'selector'],
      },
      run: async (p) =>
        withOptionalShot(p.tabId, p.screenshot, await unwrap(bridge.click(p.tabId, p.selector))),
    },
    type: {
      description:
        'Type text into the field matching a CSS selector in a real tab; set submit=true to press ' +
        'Enter / submit the form. Set screenshot=true to get an image of the result back ' +
        '(best-effort). May prompt per-origin tab-control consent.',
      params: {
        type: 'object',
        properties: {
          tabId: { type: 'number' },
          selector: { type: 'string' },
          text: { type: 'string' },
          submit: { type: 'boolean' },
          screenshot: { type: 'boolean' },
        },
        required: ['tabId', 'selector', 'text'],
      },
      run: async (p) =>
        withOptionalShot(
          p.tabId,
          p.screenshot,
          await unwrap(bridge.typeText(p.tabId, p.selector, p.text, p.submit)),
        ),
    },
    scroll: {
      description:
        'Scroll a real tab — into view of `selector`, to absolute `top`, or by `deltaY` pixels ' +
        '(default 600). Set screenshot=true to get an image of the result back (best-effort). ' +
        'May prompt per-origin tab-control consent.',
      params: {
        type: 'object',
        properties: {
          tabId: { type: 'number' },
          selector: { type: 'string' },
          deltaY: { type: 'number' },
          top: { type: 'number' },
          screenshot: { type: 'boolean' },
        },
        required: ['tabId'],
      },
      run: async (p) =>
        withOptionalShot(
          p.tabId,
          p.screenshot,
          await unwrap(
            bridge.scroll(p.tabId, { selector: p.selector, deltaY: p.deltaY, top: p.top }),
          ),
        ),
    },
    navigate: {
      description:
        'Load a URL in a real tab. May prompt per-origin tab-control consent (for the current origin).',
      params: {
        type: 'object',
        properties: { tabId: { type: 'number' }, url: { type: 'string' } },
        required: ['tabId', 'url'],
      },
      run: (p) => unwrap(bridge.navigate(p.tabId, p.url)),
    },
    refresh: {
      description: 'Force an immediate re-poll of the real tab list and return it',
      params: { type: 'object', properties: {} },
      run: () => pollOnce(),
    },
  },
  view: App,
});
