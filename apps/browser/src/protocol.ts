/**
 * The agent-facing protocol: what this app publishes as state and what it accepts
 * as commands.
 *
 * Kept out of main.ts because it is a contract, not logic — 236 lines of it, which
 * was two thirds of the entrypoint. The maps are plain top-level `const`s and each
 * descriptor is wrapped in `defineAppCommand` so its `params` schema keeps typing
 * its own `run` after being spread into `defineApp`.
 */
import { defineAppCommand } from '@bundled/yaar';
import * as web from '@bundled/yaar-web';
import { currentUrl, pageTitle, activeBrowserId, updateUrlBar, clearDisplay } from './store';
import { refreshScreenshot } from './actions';
import { liveMode } from './live';
import {
  adBlockEnabled,
  blockedCount,
  rules,
  setAdBlock,
  addBlockRule,
  refreshStats,
  currentSiteExempt,
  networkBlocked,
  popupTabs,
} from './adblock';
import { recentDownloads, captureUrl, type DownloadEntry } from './downloads';
import {
  attach,
  browserOpts,
  ensureBrowserId,
  setLive,
  listTabs,
  switchTab,
  newTab,
  closeTab,
} from './session';

export const browserState = {
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
  liveMode: {
    description:
      'Whether the live view is on: a WebSocket screencast painted on a canvas with the ' +
      "user's mouse and keyboard forwarded into the page. False means the still " +
      'screenshot, which is what the agent normally watches. Set with set_live_mode.',
    schema: { type: 'boolean' },
    get: () => liveMode(),
  },
  tabs: {
    description:
      'Every tab open in the remote browser, newest state each read. `browserId` is the ' +
      'id switch_tab and close_tab take; `active` marks the one this window is driving, ' +
      'which is where every other command lands.',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          browserId: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          active: { type: 'boolean' },
        },
      },
    },
    get: () => listTabs(),
  },
  adBlockEnabled: {
    description:
      'Whether ad/popup/overlay suppression is on. Default true. This is DOM-level ' +
      'only — it hides ad elements, neutralizes window.open and strips full-screen ' +
      'interstitials after they load; it cannot stop the requests themselves. False ' +
      'here means off globally; a site on the exception list reads true but is not ' +
      'blocked (see get_block_stats.siteExempt). Set with set_ad_block.',
    schema: { type: 'boolean' },
    get: () => adBlockEnabled(),
  },
  blockedCount: {
    description:
      'Elements hidden + popups swallowed + requests Chrome refused, on the page ' +
      'currently on screen. Resets to 0 on every navigation. Polled every 5s, so it ' +
      'lags a burst of late-inserted ads by up to that.',
    schema: { type: 'number' },
    get: () => blockedCount(),
  },
  popupTabs: {
    description:
      'Tabs the server saw this page open (popups/popunders), with their browserIds, ' +
      'since the last navigation. Recorded, never auto-closed: the new tab is often ' +
      'the page the user actually wanted, or a login in progress. Close with close_tab.',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: { browserId: { type: 'string' }, url: { type: 'string' } },
      },
    },
    get: () => popupTabs(),
  },
  downloads: {
    description:
      'Files saved out of the remote browser this session, newest first, as ' +
      '{ name, url, path, uri, bytes, at }. Written to shared/browser/downloads/, so any ' +
      'app can read one without a permission grant. Empty is the normal state: a file is ' +
      'saved when the download command is called, the toolbar button is pressed, or the ' +
      'page itself downloads something. Not a history — it resets when the window reloads, ' +
      'while the files themselves persist.',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          url: { type: 'string' },
          path: { type: 'string' },
          uri: { type: 'string' },
          bytes: { type: 'number' },
          at: { type: 'number' },
        },
      },
    },
    get: (): DownloadEntry[] => recentDownloads(),
  },
};

// ── Navigation ──────────────────────────────────────────────────────────────

export const navigationCommands = {
  open: defineAppCommand({
    description: 'Navigate to URL (auto-creates session if needed)',
    params: {
      type: 'object',
      properties: { url: { type: 'string' }, mobile: { type: 'boolean' } },
      required: ['url'],
    },
    run: async (p) => {
      return web.open(p.url, { ...(await browserOpts()), mobile: p.mobile, visible: false });
    },
  }),
  navigate_back: defineAppCommand({
    description: 'Go back in browser history',
    params: { type: 'object', properties: {} },
    run: async () => web.navigate({ direction: 'back', browserId: await ensureBrowserId() }),
  }),
  navigate_forward: defineAppCommand({
    description: 'Go forward in browser history',
    params: { type: 'object', properties: {} },
    run: async () => web.navigate({ direction: 'forward', browserId: await ensureBrowserId() }),
  }),
  scroll: defineAppCommand({
    description: 'Scroll the page',
    params: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'number', description: 'Pixels to scroll. Default: one viewport.' },
      },
      required: ['direction'],
    },
    run: async (p) => web.scroll({ ...p, ...(await browserOpts()) }),
  }),
};

// ── Interaction ─────────────────────────────────────────────────────────────

export const interactionCommands = {
  click: defineAppCommand({
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
    run: async (p) => web.click({ ...p, ...(await browserOpts()) }),
  }),
  type: defineAppCommand({
    description: 'Type text into an element',
    params: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' } },
      required: ['selector', 'text'],
    },
    run: async (p) => web.type({ ...p, ...(await browserOpts()) }),
  }),
  press: defineAppCommand({
    description: 'Press a key',
    params: {
      type: 'object',
      properties: { key: { type: 'string' }, selector: { type: 'string' } },
      required: ['key'],
    },
    run: async (p) => web.press({ ...p, ...(await browserOpts()) }),
  }),
  hover: defineAppCommand({
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
    run: async (p) => web.hover({ ...p, ...(await browserOpts()) }),
  }),
  wait_for: defineAppCommand({
    description: 'Wait for a selector to appear',
    params: {
      type: 'object',
      properties: { selector: { type: 'string' }, timeout: { type: 'number' } },
      required: ['selector'],
    },
    run: async (p) => web.waitFor({ ...p, ...(await browserOpts()) }),
  }),
};

// ── Reading the page ────────────────────────────────────────────────────────

export const inspectionCommands = {
  screenshot: defineAppCommand({
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
      const result = (await web.screenshot({ ...p, ...(await browserOpts()) })) as {
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
  extract: defineAppCommand({
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
    run: async (p) => web.extract({ ...p, ...(await browserOpts()) }),
  }),
  extract_images: defineAppCommand({
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
    run: async (p) => web.extractImages({ ...p, ...(await browserOpts()) }),
  }),
  html: defineAppCommand({
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
    run: async (p) => web.html({ ...p, ...(await browserOpts()) }),
  }),
  annotate: defineAppCommand({
    description: 'Show numbered badges on interactive elements',
    params: { type: 'object', properties: {} },
    run: async () => web.annotate(await ensureBrowserId()),
  }),
  remove_annotations: defineAppCommand({
    description: 'Remove annotation badges',
    params: { type: 'object', properties: {} },
    run: async () => web.removeAnnotations(await ensureBrowserId()),
  }),
};

// ── Ad, popup and overlay blocking ───────────────────────────────────

export const adBlockCommands = {
  set_ad_block: defineAppCommand({
    description:
      'Turn ad/popup/overlay blocking on or off — the toolbar shield. Three layers: ' +
      'network (Chrome refuses requests to blocklisted hosts), an init script that ' +
      'claims window.open before page scripts run, and DOM cleanup. Applies to the ' +
      'page already on screen: turning it off restores every element the blocker hid, ' +
      'without a reload. Use scope "site" to make an exception for the current host ' +
      'instead of flipping the global switch; exceptions persist. The network and ' +
      'init-script layers are shared by every tab, so a site exception switches them ' +
      'off for all tabs while that site is on screen.',
    params: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          description: 'true to block. With scope "site", false adds the exception.',
        },
        scope: {
          type: 'string',
          enum: ['global', 'site'],
          description: 'Default "global". "site" edits the exception list for the current host.',
        },
      },
      required: ['enabled'],
    },
    run: async (p) => setAdBlock(p.enabled, p.scope ?? 'global', await ensureBrowserId()),
  }),
  get_block_stats: defineAppCommand({
    description:
      'What the blocker has done to the page on screen, read live from it: elements ' +
      'hidden, popups swallowed in-page, requests Chrome refused (`networkBlocked`), ' +
      'popup tabs the server saw open (`popupTabs`), and whether the DOM payload is ' +
      'still installed. `active: false` with blocking enabled means the page navigated ' +
      'and has not been swept yet.',
    params: { type: 'object', properties: {} },
    run: async () => {
      const stats = await refreshStats(await ensureBrowserId());
      return {
        ...(stats ?? { blocked: 0, popups: 0, hidden: 0, active: false, url: currentUrl() }),
        networkBlocked: networkBlocked(),
        popupTabs: popupTabs(),
        adBlockEnabled: adBlockEnabled(),
        siteExempt: currentSiteExempt(),
        allowDomains: rules().allowDomains,
      };
    },
  }),
  add_block_rule: defineAppCommand({
    description:
      'Add a rule to blocklist.json in app storage, which the user can also edit by ' +
      'hand. The kind is inferred from the pattern — CSS punctuation means a selector, ' +
      'a slash means a URL fragment, anything else is a host — so pass `kind` when that ' +
      'guess would be wrong. Takes effect on the next sweep, not retroactively.',
    params: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'e.g. "adsterra.com", "/adframe", or "ins.adsbygoogle"',
        },
        kind: {
          type: 'string',
          enum: ['host', 'urlPattern', 'selector'],
          description: 'Override the inferred list.',
        },
      },
      required: ['pattern'],
    },
    run: async (p) => addBlockRule(p.pattern, p.kind),
  }),
};

// ── UI controls: local, no verb call ────────────────────────────────────────

export const uiCommands = {
  refresh: defineAppCommand({
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
  }),
  clear: defineAppCommand({
    description: 'Clear the browser display',
    params: { type: 'object', properties: {} },
    run: () => {
      clearDisplay();
    },
  }),
  attach: defineAppCommand({
    description:
      'Switch to a different browser by ID, without re-capturing. Prefer switch_tab, ' +
      'which also refreshes what is on screen.',
    params: {
      type: 'object',
      properties: { browserId: { type: 'string' } },
      required: ['browserId'],
    },
    run: (p) => {
      attach(p.browserId);
      return { browserId: p.browserId };
    },
  }),
  set_live_mode: defineAppCommand({
    description:
      "Turn the live view on or off — the toolbar's ◉ Live toggle. On: a screencast " +
      'painted onto a canvas, which the user can drive with mouse and keyboard. Off: ' +
      'the polled still screenshot. Read the current setting from the liveMode state key.',
    params: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true for live, false for the still view' },
      },
      required: ['enabled'],
    },
    run: async (p) => {
      await setLive(p.enabled);
      return { liveMode: liveMode() };
    },
  }),
  switch_tab: defineAppCommand({
    description:
      'Show another open tab and send every later command to it. Always re-captures, so ' +
      'a tab switched back to shows its current page rather than the frame it was left ' +
      'on. Ids come from the tabs state key.',
    params: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'browserId of the tab, from the tabs state key' },
      },
      required: ['tabId'],
    },
    run: async (p) => {
      await switchTab(p.tabId);
      return { tabId: p.tabId };
    },
  }),
  new_tab: defineAppCommand({
    description:
      'Open a tab of its own and switch to it. Without a url it opens about:blank. At ' +
      'most 5 tabs may be open at once, so close what you are done with.',
    params: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Page to open. Default about:blank.' } },
    },
    run: async (p) => newTab(p?.url),
  }),
  close_tab: defineAppCommand({
    description:
      'Close a tab in the remote browser. Closing the tab being watched moves the window ' +
      'to whatever tab is left, re-captured.',
    params: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'browserId of the tab, from the tabs state key' },
      },
      required: ['tabId'],
    },
    run: async (p) => closeTab(p.tabId),
  }),
};

// ── Downloads ────────────────────────────────────────────────────────

export const downloadCommands = {
  download: defineAppCommand({
    description:
      'Save a file out of the browser into shared/browser/downloads/, opening a PDF in a ' +
      'window of its own. Returns { name, url, path, uri, bytes, at }. The transfer is made ' +
      'BY THE TAB, so it carries the tab’s cookies and a file behind a login works; the ' +
      'bytes go straight to disk, so size is bounded by the disk and not by a response cap. ' +
      'Omit url to save the page currently on screen.',
    params: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The file to save. Defaults to the page currently on screen.',
        },
        filename: {
          type: 'string',
          description:
            'Name to store it under. Default: the name the server suggested, else the URL’s ' +
            'last path segment, with .pdf appended when the response is a PDF without one.',
        },
      },
    },
    run: async (p) => captureUrl({ url: p.url, filename: p.filename }),
  }),
};
