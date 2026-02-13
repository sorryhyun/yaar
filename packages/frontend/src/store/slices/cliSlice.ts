/**
 * CLI slice - manages terminal-like CLI mode state.
 */
import type { SliceCreator, CliSlice } from '../types';

const MAX_CLI_ENTRIES = 5000;

export const createCliSlice: SliceCreator<CliSlice> = (set, _get) => ({
  cliMode: false,
  cliHistory: {},
  cliStreaming: {},

  toggleCliMode: () =>
    set((state) => {
      state.cliMode = !state.cliMode;
    }),

  addCliEntry: (entry) =>
    set((state) => {
      const monitorId = entry.monitorId || 'monitor-0';
      if (!state.cliHistory[monitorId]) {
        state.cliHistory[monitorId] = [];
      }
      state.cliHistory[monitorId].push({
        ...entry,
        id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        monitorId,
        timestamp: Date.now(),
      });
      // FIFO cap
      if (state.cliHistory[monitorId].length > MAX_CLI_ENTRIES) {
        state.cliHistory[monitorId] = state.cliHistory[monitorId].slice(-MAX_CLI_ENTRIES);
      }
    }),

  updateCliStreaming: (agentId, content, type, monitorId) =>
    set((state) => {
      const mid = monitorId || 'monitor-0';
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
        const monitorId = streaming.monitorId || 'monitor-0';
        if (!state.cliHistory[monitorId]) {
          state.cliHistory[monitorId] = [];
        }
        state.cliHistory[monitorId].push({
          ...streaming,
          id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: Date.now(),
        });
        if (state.cliHistory[monitorId].length > MAX_CLI_ENTRIES) {
          state.cliHistory[monitorId] = state.cliHistory[monitorId].slice(-MAX_CLI_ENTRIES);
        }
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
