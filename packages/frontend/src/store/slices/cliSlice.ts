/**
 * CLI slice - manages terminal-like CLI mode state.
 */
import type { SliceCreator, CliSlice } from '../types';
import { generateId, capArray } from '../helpers';

const MAX_CLI_ENTRIES = 5000;

export const createCliSlice: SliceCreator<CliSlice> = (set, _get) => ({
  cliMode: false,
  cliHistory: {},
  cliStreaming: {},

  toggleCliMode: () =>
    set((state) => {
      state.cliMode = !state.cliMode;
      // Auto-open agent panel when entering CLI mode
      if (state.cliMode) {
        state.agentPanelOpen = true;
      }
    }),

  addCliEntry: (entry) =>
    set((state) => {
      const monitorId = entry.monitorId || '0';
      if (!state.cliHistory[monitorId]) {
        state.cliHistory[monitorId] = [];
      }
      state.cliHistory[monitorId].push({
        ...entry,
        id: generateId('cli'),
        monitorId,
        timestamp: Date.now(),
      });
      state.cliHistory[monitorId] = capArray(state.cliHistory[monitorId], MAX_CLI_ENTRIES);
    }),

  updateCliStreaming: (agentId, content, type, monitorId) =>
    set((state) => {
      const mid = monitorId || '0';
      state.cliStreaming[agentId] = {
        id: `cli-stream-${agentId}`,
        type,
        content,
        agentId,
        monitorId: mid,
        timestamp: Date.now(),
      };
    }),

  finalizeCliStreaming: (agentId) =>
    set((state) => {
      const streaming = state.cliStreaming[agentId];
      if (streaming && streaming.content) {
        const monitorId = streaming.monitorId || '0';
        if (!state.cliHistory[monitorId]) {
          state.cliHistory[monitorId] = [];
        }
        state.cliHistory[monitorId].push({
          ...streaming,
          id: generateId('cli'),
          timestamp: Date.now(),
        });
        state.cliHistory[monitorId] = capArray(state.cliHistory[monitorId], MAX_CLI_ENTRIES);
      }
      delete state.cliStreaming[agentId];
    }),

  clearCliHistory: (monitorId) =>
    set((state) => {
      if (monitorId) {
        state.cliHistory[monitorId] = [];
      } else {
        state.cliHistory = {};
      }
    }),
});
