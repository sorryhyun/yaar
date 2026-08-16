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
  closeAppWindows,
  closeWindow,
  interruptAgent,
  killAppAgent,
  refreshAll,
  windows,
} from './data';

export const appState = {
  stats: {
    description: 'Overview: agent, window, and running-app counts',
    get: () => ({
      agents: agentStats(),
      windowCount: windows().length,
      appCount: appProcesses().length,
      orphanedAppCount: appProcesses().filter((p) => p.orphaned).length,
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
    run: async (p: { agentId: string }) => {
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
    run: async (p: { windowId: string }) => {
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
    run: async (p: { appId: string }) => {
      await killAppAgent(p.appId);
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
    run: async (p: { appId: string }) => {
      await closeAppWindows(p.appId);
      return { ok: true };
    },
  },
};
