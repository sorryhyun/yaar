export {};

// The agent-facing protocol: what another agent can read and what it can do.
//
// Both maps are plain const object literals so the compiler can read them
// statically — no factory calls, no computed keys, no template-literal
// descriptions. Params are JSON Schema literals rather than Zod schemas on
// purpose: a Zod schema is a call result, which would force the compiler to
// import this app to extract the manifest.
//
// State keys and command names here ARE the public contract. Renaming one
// breaks every caller; adding is safe, removing is not.

import {
  agentList,
  agentStats,
  appProcesses,
  browsers,
  closeAppWindows,
  closeWindow,
  interruptAgent,
  killAppAgent,
  killBrowser,
  refreshAll,
  reviveBrowser,
  windows,
} from './data';

export const appState = {
  stats: {
    description: 'Overview: agent, window, running-app and browser-session counts',
    get: () => ({
      agents: agentStats(),
      windowCount: windows().length,
      appCount: appProcesses().length,
      orphanedAppCount: appProcesses().filter((p) => p.orphaned).length,
      browserCount: browsers().length,
    }),
  },
  agents: {
    description: 'List of all agents with type and status',
    get: () => agentList(),
  },
  windows: {
    description: 'List of all open windows',
    get: () => windows(),
  },
  apps: {
    description:
      'Running apps — each with its open windows and its app agent. An app is "orphaned" ' +
      'when its agent is still alive with no window open, holding a slot and its context.',
    get: () => appProcesses(),
  },
  browsers: {
    description:
      'Sandbox browser sessions. State is "live" when a CDP socket is behind the id, ' +
      '"suspended" when only its record is (reviving reopens it on the same page, still ' +
      'logged in), or "crashed" when the tab died and could not be brought back.',
    get: () => browsers(),
  },
};

export const appCommands = {
  refresh: {
    description: 'Force refresh all data',
    params: { type: 'object', properties: {} },
    run: async () => {
      await refreshAll();
      return { ok: true };
    },
  },
  interruptAgent: {
    description: 'Interrupt a running agent by ID',
    params: {
      type: 'object',
      properties: { agentId: { type: 'string' } },
      required: ['agentId'],
    },
    run: async (p) => {
      await interruptAgent(p.agentId);
      return { ok: true };
    },
  },
  closeWindow: {
    description: 'Close a window by ID',
    params: {
      type: 'object',
      properties: { windowId: { type: 'string' } },
      required: ['windowId'],
    },
    run: async (p) => {
      await closeWindow(p.windowId);
      return { ok: true };
    },
  },
  killAppAgent: {
    description:
      'Dispose an app agent by appId, freeing its slot and dropping its context. The app stays ' +
      'installed and its windows stay open; the next interaction spawns a fresh agent.',
    params: {
      type: 'object',
      properties: { appId: { type: 'string' } },
      required: ['appId'],
    },
    run: async (p) => {
      await killAppAgent(p.appId);
      return { ok: true };
    },
  },
  killBrowser: {
    description:
      'Close a browser session by browserId, and the window showing it. Its record is ' +
      'forgotten, so the id cannot be revived afterwards.',
    params: {
      type: 'object',
      properties: { browserId: { type: 'string' } },
      required: ['browserId'],
    },
    run: async (p) => {
      await killBrowser(p.browserId);
      return { ok: true };
    },
  },
  reviveBrowser: {
    description:
      'Put a socket back behind a suspended browser session, re-navigating it to the page ' +
      'it was left on. The persisted profile still holds its cookies.',
    params: {
      type: 'object',
      properties: { browserId: { type: 'string' } },
      required: ['browserId'],
    },
    run: async (p) => {
      await reviveBrowser(p.browserId);
      return { ok: true };
    },
  },
  closeAppWindows: {
    description: 'Close every open window belonging to an app. Leaves its agent alone.',
    params: {
      type: 'object',
      properties: { appId: { type: 'string' } },
      required: ['appId'],
    },
    run: async (p) => {
      await closeAppWindows(p.appId);
      return { ok: true };
    },
  },
};
