/**
 * Agents slice - manages active agents and window agents.
 *
 * windowAgents is keyed by agentId (not windowId) so multiple parallel agents
 * working on the same window each get their own entry.
 */
import { agentKindFromRole } from '@yaar/shared';
import type { SliceCreator, AgentsSlice } from '../types';

export const createAgentsSlice: SliceCreator<AgentsSlice> = (set, _get) => ({
  activeAgents: {},
  agentPanelOpen: false,
  windowAgents: {},

  setAgentActive: (agentId, status, monitorId) =>
    set((state) => {
      const prev = state.activeAgents[agentId];
      // Every streamed chunk re-asserts the same status ("Responding..."), and each
      // write hands Immer a new object that re-renders every `activeAgents` subscriber.
      // On a multi-monitor desktop that is one render per token per streaming monitor,
      // for a value that did not change. A monitorId the entry does not have yet is
      // also a change — the first event of a turn may not carry one.
      if (prev?.status === status && (monitorId === undefined || prev.monitorId === monitorId))
        return;
      state.activeAgents[agentId] = {
        id: agentId,
        status,
        startedAt: prev?.startedAt ?? Date.now(),
        // Only reached when the status actually changed — the coalescing return above
        // is what makes this the phase's start rather than the last chunk's arrival.
        statusSince: Date.now(),
        subagentCount: prev?.subagentCount ?? 0,
        // `agentId` is the per-turn role on every streaming event, and a role names its
        // tier. The snapshot path sends `kind` instead, because what it reports is an
        // instanceId with nothing to parse.
        kind: agentKindFromRole(agentId),
        ...((monitorId ?? prev?.monitorId) ? { monitorId: monitorId ?? prev?.monitorId } : {}),
      };
    }),

  clearAgent: (agentId) =>
    set((state) => {
      delete state.activeAgents[agentId];
    }),

  clearAllAgents: () =>
    set((state) => {
      state.activeAgents = {};
    }),

  toggleAgentPanel: () =>
    set((state) => {
      state.agentPanelOpen = !state.agentPanelOpen;
    }),

  registerWindowAgent: (windowId, agentId, status) =>
    set((state) => {
      state.windowAgents[agentId] = { agentId, windowId, status };
    }),

  updateWindowAgentStatus: (agentId, status) =>
    set((state) => {
      if (state.windowAgents[agentId]) {
        if (status === 'released') {
          delete state.windowAgents[agentId];
        } else {
          state.windowAgents[agentId].status = status;
        }
      }
    }),

  removeWindowAgent: (windowId) =>
    set((state) => {
      for (const [key, wa] of Object.entries(state.windowAgents)) {
        if (wa.windowId === windowId) {
          delete state.windowAgents[key];
        }
      }
    }),

  incrementSubagentCount: (agentId) =>
    set((state) => {
      if (state.activeAgents[agentId]) {
        state.activeAgents[agentId].subagentCount += 1;
      }
    }),

  decrementSubagentCount: (agentId) =>
    set((state) => {
      if (state.activeAgents[agentId] && state.activeAgents[agentId].subagentCount > 0) {
        state.activeAgents[agentId].subagentCount -= 1;
      }
    }),
});
