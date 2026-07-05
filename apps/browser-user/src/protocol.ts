/**
 * App Protocol registration for the Real Browser app.
 *
 * Lets a monitor agent observe AND drive the user's REAL Chrome tabs via
 * `app_query` (tabs / activeTab / connected) and `app_command`:
 *   - manage:  focus / close / group / move / track / refresh
 *   - read:    extract (page text) / screenshot (PNG of the visible tab)
 *   - drive:   click / type / scroll / navigate (synthetic DOM events over the Bridge)
 * Every command delegates to the matching `./bridge.ts` helper and unwraps its envelope, so the
 * agent receives the bare payload (e.g. the extracted `{ url, title, text }`) instead of a
 * `{ ok, data }` wrapper. Consent refusals / failures throw, which the App Protocol surfaces to
 * the agent as a clean command error. The drive/read verbs are gated per-origin on the server
 * (tab-control consent for click/type/scroll/navigate, content-read for extract/screenshot) — the
 * user's "Allow use" button pre-grants both, so a granted tab drives without further prompts.
 */
import { app } from '@bundled/yaar';
import { tabs, connected, activeTab, pollOnce } from './store';
import * as bridge from './bridge';

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

export function registerBrowserUserProtocol(): void {
  if (!app) return;

  app.register({
    appId: 'browser-user',
    name: 'Real Browser',
    state: {
      manifest: {
        description: 'App capabilities',
        handler: () => ({
          state: ['tabs', 'activeTab', 'connected'],
          commands: [
            'focus',
            'close',
            'group',
            'move',
            'track',
            'extract',
            'screenshot',
            'click',
            'type',
            'scroll',
            'navigate',
            'refresh',
          ],
        }),
      },
      tabs: {
        description:
          "The user's real Chrome tabs (id, url, title, active, audible, isSelf, allowed). " +
          '`allowed` is true once the user has granted full agent use of that tab (via its "Allow use" button).',
        handler: () => [...tabs()],
      },
      activeTab: {
        description: 'The currently active real tab, or null if none/disconnected',
        handler: () => activeTab(),
      },
      connected: {
        description: 'Whether the YAAR Bridge extension is connected',
        handler: () => connected(),
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
        handler: (p: { tabId: number }) => unwrap(bridge.focus(p.tabId)),
      },
      close: {
        description:
          "Close a real browser tab. Refused for YAAR's own tab; may prompt per-origin consent for logged-in sites.",
        params: {
          type: 'object',
          properties: { tabId: { type: 'number' } },
          required: ['tabId'],
        },
        handler: (p: { tabId: number }) => unwrap(bridge.close(p.tabId)),
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
        handler: (p: { tabId: number; tabIds?: number[]; groupTitle?: string }) =>
          unwrap(bridge.group(p.tabId, p.tabIds, p.groupTitle)),
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
        handler: (p: { tabId: number; index?: number; windowId?: number }) =>
          unwrap(bridge.move(p.tabId, p.index, p.windowId)),
      },
      track: {
        description: 'Show a tracking cursor / highlight on a real browser tab',
        params: {
          type: 'object',
          properties: { tabId: { type: 'number' } },
          required: ['tabId'],
        },
        handler: (p: { tabId: number }) => unwrap(bridge.track(p.tabId)),
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
        handler: (p: { tabId: number; maxChars?: number }) =>
          unwrap(bridge.extract(p.tabId, p.maxChars)),
      },
      screenshot: {
        description:
          'Capture a PNG (data URL) of a real tab. The tab must be focused first (see `focus`). ' +
          'May prompt per-origin content consent.',
        params: {
          type: 'object',
          properties: { tabId: { type: 'number' } },
          required: ['tabId'],
        },
        handler: (p: { tabId: number }) => unwrap(bridge.screenshot(p.tabId)),
      },
      click: {
        description:
          'Click the element matching a CSS selector in a real tab. May prompt per-origin tab-control consent.',
        params: {
          type: 'object',
          properties: { tabId: { type: 'number' }, selector: { type: 'string' } },
          required: ['tabId', 'selector'],
        },
        handler: (p: { tabId: number; selector: string }) =>
          unwrap(bridge.click(p.tabId, p.selector)),
      },
      type: {
        description:
          'Type text into the field matching a CSS selector in a real tab; set submit=true to press ' +
          'Enter / submit the form. May prompt per-origin tab-control consent.',
        params: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            selector: { type: 'string' },
            text: { type: 'string' },
            submit: { type: 'boolean' },
          },
          required: ['tabId', 'selector', 'text'],
        },
        handler: (p: { tabId: number; selector: string; text: string; submit?: boolean }) =>
          unwrap(bridge.typeText(p.tabId, p.selector, p.text, p.submit)),
      },
      scroll: {
        description:
          'Scroll a real tab — into view of `selector`, to absolute `top`, or by `deltaY` pixels ' +
          '(default 600). May prompt per-origin tab-control consent.',
        params: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            selector: { type: 'string' },
            deltaY: { type: 'number' },
            top: { type: 'number' },
          },
          required: ['tabId'],
        },
        handler: (p: { tabId: number; selector?: string; deltaY?: number; top?: number }) =>
          unwrap(bridge.scroll(p.tabId, { selector: p.selector, deltaY: p.deltaY, top: p.top })),
      },
      navigate: {
        description:
          'Load a URL in a real tab. May prompt per-origin tab-control consent (for the current origin).',
        params: {
          type: 'object',
          properties: { tabId: { type: 'number' }, url: { type: 'string' } },
          required: ['tabId', 'url'],
        },
        handler: (p: { tabId: number; url: string }) => unwrap(bridge.navigate(p.tabId, p.url)),
      },
      refresh: {
        description: 'Force an immediate re-poll of the real tab list and return it',
        params: { type: 'object', properties: {} },
        handler: () => pollOnce(),
      },
    },
  });
}
