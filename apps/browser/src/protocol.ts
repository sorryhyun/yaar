/**
 * App Protocol registration for the Browser app.
 * Separated to keep main.ts focused on rendering and event logic.
 */

export interface BrowserProtocolDeps {
  getCurrentUrl: () => string;
  getActiveBrowserId: () => string;
  updateUrlBar: (url: string, title?: string) => void;
  refreshScreenshot: () => void;
  clearDisplay: () => void;
  attach: (browserId: string) => void;
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
          state: ['currentUrl', 'browserId'],
          commands: ['refresh', 'clear', 'attach'],
        }),
      },
      currentUrl: {
        description: 'Currently displayed URL',
        handler: () => deps.getCurrentUrl(),
      },
      browserId: {
        description: 'Currently connected browser ID',
        handler: () => deps.getActiveBrowserId(),
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
      attach: {
        description: 'Switch to a different browser by ID. Params: { browserId }',
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
