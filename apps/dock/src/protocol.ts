/**
 * App Protocol registration for the Dock app.
 * Separated to keep main.ts focused on rendering and lifecycle logic.
 */
import { app } from '@bundled/yaar';

export interface DockProtocolDeps {
  /* ── State getters ───────────────────── */
  getNowIso: () => string;
  getTimeStr: () => string;
  getDateStr: () => string;
  getWeatherIcon: () => string;
  getWeatherTemp: () => string;
  getWeatherCity: () => string;
  getShowPanel: () => boolean;
  getPanelOpacity: () => number;
  getPanelBlurPx: () => number;

  /* ── State setters ───────────────────── */
  setShowPanel: (v: boolean) => void;
  setPanelOpacity: (v: number) => void;
  setPanelBlurPx: (v: number) => void;

  /* ── Actions ───────────────────────── */
  renderNow: () => void;
  initWeather: () => Promise<void>;
}

export function registerDockProtocol(deps: DockProtocolDeps): void {
  if (!app) return;

  app.register({
    appId: 'dock',
    name: 'Dock',
    state: {
      nowIso: {
        description: 'Current time in ISO format',
        handler: () => deps.getNowIso(),
      },
      display: {
        description: 'Current displayed date/time text: { time, date }',
        handler: () => ({
          time: deps.getTimeStr(),
          date: deps.getDateStr(),
        }),
      },
      appearance: {
        description: 'Current dock appearance settings: { showPanel, panelOpacity, panelBlurPx }',
        handler: () => ({
          showPanel: deps.getShowPanel(),
          panelOpacity: deps.getPanelOpacity(),
          panelBlurPx: deps.getPanelBlurPx(),
        }),
      },
      weather: {
        description: 'Current weather data: { icon, temp, city }',
        handler: () => ({
          icon: deps.getWeatherIcon(),
          temp: deps.getWeatherTemp(),
          city: deps.getWeatherCity(),
        }),
      },
    },
    commands: {
      refreshNow: {
        description: 'Force immediate clock refresh. Params: {}',
        params: { type: 'object', properties: {} },
        handler: () => {
          deps.renderNow();
          return { nowIso: deps.getNowIso() };
        },
      },
      refreshWeather: {
        description: 'Force re-fetch weather data. Params: {}',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await deps.initWeather();
          return {
            weather: {
              icon: deps.getWeatherIcon(),
              temp: deps.getWeatherTemp(),
              city: deps.getWeatherCity(),
            },
          };
        },
      },
      setAppearance: {
        description:
          'Update dock appearance. Params: { showPanel?: boolean, panelOpacity?: number (0–1), panelBlurPx?: number (0–40) }',
        params: {
          type: 'object',
          properties: {
            showPanel: { type: 'boolean' },
            panelOpacity: { type: 'number', minimum: 0, maximum: 1 },
            panelBlurPx: { type: 'number', minimum: 0, maximum: 40 },
          },
        },
        handler: (p: Record<string, unknown>) => {
          if (typeof p?.showPanel === 'boolean') deps.setShowPanel(p.showPanel as boolean);
          if (typeof p?.panelOpacity === 'number')
            deps.setPanelOpacity(Math.max(0, Math.min(1, p.panelOpacity as number)));
          if (typeof p?.panelBlurPx === 'number')
            deps.setPanelBlurPx(Math.max(0, Math.min(40, p.panelBlurPx as number)));
          // Signals are reactive — DOM updates automatically, no applyAppearance() needed
          return {
            appearance: {
              showPanel: deps.getShowPanel(),
              panelOpacity: deps.getPanelOpacity(),
              panelBlurPx: deps.getPanelBlurPx(),
            },
          };
        },
      },
    },
  });
}
