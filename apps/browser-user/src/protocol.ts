/**
 * App Protocol registration for the Real Browser app.
 *
 * Lets a monitor agent observe and drive the user's REAL Chrome tabs via
 * `app_query` (tabs / activeTab / connected) and `app_command`
 * (focus / close / group / move / track / extract / refresh). Every command
 * delegates to the matching `./bridge.ts` helper and returns its envelope so
 * the result (including consent refusals) flows straight back to the agent.
 */
import { app } from '@bundled/yaar';
import { tabs, connected, activeTab, pollOnce } from './store';
import * as bridge from './bridge';

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
          commands: ['focus', 'close', 'group', 'move', 'track', 'extract', 'refresh'],
        }),
      },
      tabs: {
        description: "The user's real Chrome tabs (id, url, title, active, audible, isSelf)",
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
        handler: (p: { tabId: number }) => bridge.focus(p.tabId),
      },
      close: {
        description:
          "Close a real browser tab. Refused for YAAR's own tab; may prompt per-origin consent for logged-in sites.",
        params: {
          type: 'object',
          properties: { tabId: { type: 'number' } },
          required: ['tabId'],
        },
        handler: (p: { tabId: number }) => bridge.close(p.tabId),
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
          bridge.group(p.tabId, p.tabIds, p.groupTitle),
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
          bridge.move(p.tabId, p.index, p.windowId),
      },
      track: {
        description: 'Show a tracking cursor / highlight on a real browser tab',
        params: {
          type: 'object',
          properties: { tabId: { type: 'number' } },
          required: ['tabId'],
        },
        handler: (p: { tabId: number }) => bridge.track(p.tabId),
      },
      extract: {
        description:
          "Extract the visible page text from a real browser tab. May prompt per-origin consent. maxChars caps the returned text.",
        params: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            maxChars: { type: 'number' },
          },
          required: ['tabId'],
        },
        handler: (p: { tabId: number; maxChars?: number }) => bridge.extract(p.tabId, p.maxChars),
      },
      refresh: {
        description: 'Force an immediate re-poll of the real tab list and return it',
        params: { type: 'object', properties: {} },
        handler: () => pollOnce(),
      },
    },
  });
}
