/**
 * Agents slice - manages active agents and window agents.
 *
 * windowAgents is keyed by agentId (not windowId) so multiple parallel agents
 * working on the same window each get their own entry.
 */
import type { SliceCreator, AgentsSlice } from '../types'

export const createAgentsSlice: SliceCreator<AgentsSlice> = (set, _get) => ({
  activeAgents: {},
  agentPanelOpen: false,
  windowAgents: {},

  setAgentActive: (agentId, status) => set((state) => {
    state.activeAgents[agentId] = {
      id: agentId,
      status,
      startedAt: state.activeAgents[agentId]?.startedAt ?? Date.now(),
    }
  }),

  clearAgent: (agentId) => set((state) => {
    delete state.activeAgents[agentId]
  }),

  clearAllAgents: () => set((state) => {
    state.activeAgents = {}
  }),

  toggleAgentPanel: () => set((state) => {
    state.agentPanelOpen = !state.agentPanelOpen
  }),

  registerWindowAgent: (windowId, agentId, status) => set((state) => {
    state.windowAgents[agentId] = { agentId, windowId, status }
  }),

  updateWindowAgentStatus: (agentId, status) => set((state) => {
    if (state.windowAgents[agentId]) {
      if (status === 'released') {
        delete state.windowAgents[agentId]
      } else {
        state.windowAgents[agentId].status = status
      }
    }
  }),

  removeWindowAgent: (windowId) => set((state) => {
    for (const [key, wa] of Object.entries(state.windowAgents)) {
      if (wa.windowId === windowId) {
        delete state.windowAgents[key]
      }
    }
  }),
})
