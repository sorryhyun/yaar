/**
 * CLI slice - manages terminal-like CLI mode state.
 */
import type { SliceCreator } from '../types';
import type { CliEntry } from '@/types/state';
import { generateId, capArray } from '../helpers';

export interface CliSliceState {
  cliMode: boolean;
  cliHistory: Record<string, CliEntry[]>;
  cliStreaming: Record<string, CliEntry>;
  /**
   * Routing target for typed messages, chosen from the CLI-panel toggle:
   *  - `'monitor'` (default) — the monitor agent, sandbox browsing only.
   *  - `'session'` — the session agent ("act as me"), which can drive the
   *    user's real browser.
   */
  cliTarget: 'monitor' | 'session';
}

export interface CliSliceActions {
  toggleCliMode: () => void;
  /**
   * The same switch, said rather than flipped. The phone's sideways pan lands on the
   * CLI or on the desktop from a drag whose direction already decided which, and a
   * toggle there would undo itself on the second swipe in the same direction.
   */
  setCliMode: (on: boolean) => void;
  setCliTarget: (target: 'monitor' | 'session') => void;
  addCliEntry: (entry: {
    type: CliEntry['type'];
    content: string;
    agentId?: string;
    monitorId?: string;
  }) => void;
  updateCliStreaming: (
    agentId: string,
    content: string,
    type: 'thinking' | 'response' | 'tool',
    monitorId?: string,
  ) => void;
  /** Append to the live entry, for feeds that arrive as deltas rather than snapshots. */
  appendCliStreaming: (
    agentId: string,
    delta: string,
    type: 'thinking' | 'response' | 'tool',
    monitorId?: string,
  ) => void;
  finalizeCliStreaming: (agentId: string) => void;
  clearCliHistory: (monitorId?: string) => void;
  restoreCliHistory: (
    entries: {
      type: CliEntry['type'];
      content: string;
      agentId?: string;
      monitorId: string;
      timestamp: number;
    }[],
  ) => void;
}

export type CliSlice = CliSliceState & CliSliceActions;

const MAX_CLI_ENTRIES = 5000;

export const createCliSlice: SliceCreator<CliSlice> = (set, _get) => ({
  cliMode: false,
  cliHistory: {},
  cliStreaming: {},
  cliTarget: 'monitor',

  toggleCliMode: () =>
    set((state) => {
      state.cliMode = !state.cliMode;
    }),

  setCliMode: (on) =>
    set((state) => {
      state.cliMode = on;
    }),

  setCliTarget: (target) =>
    set((state) => {
      state.cliTarget = target;
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

  appendCliStreaming: (agentId, delta, type, monitorId) =>
    set((state) => {
      const prev = state.cliStreaming[agentId];
      state.cliStreaming[agentId] = {
        id: `cli-stream-${agentId}`,
        type,
        // Only continue an entry of the same kind — a delta must never be glued
        // onto the tail of a different feed (a tool argument onto assistant text).
        content: prev?.type === type ? prev.content + delta : delta,
        agentId,
        monitorId: monitorId || prev?.monitorId || '0',
        timestamp: Date.now(),
      };
    }),

  finalizeCliStreaming: (agentId) =>
    set((state) => {
      const streaming = state.cliStreaming[agentId];
      // A live `tool` entry is the raw argument JSON streamed during the
      // `pending` phase — display-only scaffolding that is always superseded by
      // the summarized `[tool] input` entry once the arguments are complete. It
      // is dropped rather than committed, so history holds the readable form and
      // never a half-written JSON fragment (including when a turn is interrupted
      // mid-argument, where no summarized entry ever arrives).
      if (streaming?.type === 'tool') {
        delete state.cliStreaming[agentId];
        return;
      }
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

  restoreCliHistory: (entries) =>
    set((state) => {
      for (const entry of entries) {
        const monitorId = entry.monitorId || '0';
        if (!state.cliHistory[monitorId]) {
          state.cliHistory[monitorId] = [];
        }
        state.cliHistory[monitorId].push({
          ...entry,
          id: generateId('cli'),
          monitorId,
        });
      }
      // Cap each monitor's history
      for (const monitorId of Object.keys(state.cliHistory)) {
        state.cliHistory[monitorId] = capArray(state.cliHistory[monitorId], MAX_CLI_ENTRIES);
      }
    }),
});
