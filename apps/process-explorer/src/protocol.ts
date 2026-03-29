export {};

import { app } from '@bundled/yaar';
import {
  agentStats,
  agentList,
  windows,
  browsers,
  refreshAll,
  interruptAgent,
  closeWindow,
  closeBrowser,
} from './data';

export function registerProtocol() {
  if (!app) return;

  app.register({
    appId: 'process-explorer',
    name: 'Process Explorer',

    state: {
      stats: {
        description: 'Overview: agent, window, and browser counts',
        handler: () => ({
          agents: agentStats(),
          windowCount: windows().length,
          browserCount: browsers().length,
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
      browsers: {
        description: 'List of all open browser tabs',
        handler: () => browsers(),
      },
    },

    commands: {
      refresh: {
        description: 'Force refresh all data',
        params: { type: 'object', properties: {} },
        handler: async () => {
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
        handler: async (p: { agentId: string }) => {
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
        handler: async (p: { windowId: string }) => {
          await closeWindow(p.windowId);
          return { ok: true };
        },
      },
      closeBrowser: {
        description: 'Close a browser tab by ID',
        params: {
          type: 'object',
          properties: { browserId: { type: 'string' } },
          required: ['browserId'],
        },
        handler: async (p: { browserId: string }) => {
          await closeBrowser(p.browserId);
          return { ok: true };
        },
      },
    },
  });
}
