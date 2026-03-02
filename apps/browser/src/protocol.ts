/**
 * App Protocol registration for the Browser app.
 * Separated to keep main.ts focused on rendering and event logic.
 */

export interface BrowserProtocolDeps {
  /** Returns the current URL signal value */
  getCurrentUrl: () => string;
  /** Updates URL bar and optionally the page title */
  updateUrlBar: (url: string, title?: string) => void;
  /** Triggers a screenshot refresh */
  refreshScreenshot: () => void;
  /** Clears the browser display */
  clearDisplay: () => void;
}

export function registerBrowserProtocol(deps: BrowserProtocolDeps): void {
  const appApi = (window as any).yaar?.app;
  if (!appApi) return;

  appApi.register({
    appId: 'browser',
    name: 'Browser',
    state: {
      manifest: {
        description: 'App capabilities',
        handler: () => ({
          state: ['currentUrl'],
          commands: ['refresh', 'clear', 'navigate'],
        }),
      },
      currentUrl: {
        description: 'Currently displayed URL',
        handler: () => deps.getCurrentUrl(),
      },
    },
    commands: {
      refresh: {
        description: 'Refresh screenshot and optionally update URL bar. Params: { url?, title? }',
        params: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
          },
        },
        handler: (p?: { url?: string; title?: string }) => {
          if (p?.url) deps.updateUrlBar(p.url, p.title);
          deps.refreshScreenshot();
          return { ok: true, currentUrl: deps.getCurrentUrl() };
        },
      },
      clear: {
        description: 'Clear the browser display. Params: {}',
        params: { type: 'object', properties: {} },
        handler: () => {
          deps.clearDisplay();
          return { ok: true };
        },
      },
      navigate: {
        description: 'Navigate the browser to a URL. Params: { url }',
        params: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
        },
        handler: (p: { url: string }) => {
          (window as any).yaar?.app?.sendInteraction?.({ event: 'navigate_request', url: p.url });
          return { ok: true, url: p.url };
        },
      },
    },
  });
}
