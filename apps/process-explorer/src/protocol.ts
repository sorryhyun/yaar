export {};

import { app, defineCommand } from '@bundled/yaar';
import {
  agentStats,
  agentList,
  windows,
  appProcesses,
  refreshAll,
  interruptAgent,
  closeWindow,
  killAppAgent,
  closeAppWindows,
} from './data';

export function registerProtocol() {
  if (!app) return;

  app.register({
    appId: 'process-explorer',
    name: 'Process Explorer',

    state: {
      stats: {
        description: 'Overview: agent, window, and running-app counts',
        handler: () => ({
          agents: agentStats(),
          windowCount: windows().length,
          appCount: appProcesses().length,
          orphanedAppCount: appProcesses().filter((p) => p.orphaned).length,
        }),
      },
      agents: {
        description: 'List of all agents with type and status',
        handler: () => agentList(),
      },
      windows: {
        description: 'List of all open windows',
        handler: () => windows(),
      },
      apps: {
        description:
          'Running apps — each with its open windows and its app agent. An app is "orphaned" ' +
          'when its agent is still alive with no window open, holding a slot and its context.',
        handler: () => appProcesses(),
      },
    },

    commands: {
      refresh: defineCommand({
        description: 'Force refresh all data',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await refreshAll();
          return { ok: true };
        },
      }),
      interruptAgent: defineCommand({
        description: 'Interrupt a running agent by ID',
        params: {
          type: 'object',
          properties: { agentId: { type: 'string' } },
          required: ['agentId'],
        },
        handler: async (p) => {
          await interruptAgent(p.agentId);
          return { ok: true };
        },
      }),
      closeWindow: defineCommand({
        description: 'Close a window by ID',
        params: {
          type: 'object',
          properties: { windowId: { type: 'string' } },
          required: ['windowId'],
        },
        handler: async (p) => {
          await closeWindow(p.windowId);
          return { ok: true };
        },
      }),
      killAppAgent: defineCommand({
        description:
          'Dispose an app agent by appId, freeing its slot and dropping its context. The app stays ' +
          'installed and its windows stay open; the next interaction spawns a fresh agent.',
        params: {
          type: 'object',
          properties: { appId: { type: 'string' } },
          required: ['appId'],
        },
        handler: async (p) => {
          await killAppAgent(p.appId);
          return { ok: true };
        },
      }),
      closeAppWindows: defineCommand({
        description: 'Close every open window belonging to an app. Leaves its agent alone.',
        params: {
          type: 'object',
          properties: { appId: { type: 'string' } },
          required: ['appId'],
        },
        handler: async (p) => {
          await closeAppWindows(p.appId);
          return { ok: true };
        },
      }),
    },
  });
}
