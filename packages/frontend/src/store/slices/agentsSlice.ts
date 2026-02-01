/**
 * Agents slice - manages active agents and window agents.
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
    state.windowAgents[windowId] = { agentId, status }
  }),

  updateWindowAgentStatus: (windowId, status) => set((state) => {
    if (state.windowAgents[windowId]) {
      if (status === 'destroyed') {
        delete state.windowAgents[windowId]
      } else {
        state.windowAgents[windowId].status = status
      }
    }
  }),

  removeWindowAgent: (windowId) => set((state) => {
    delete state.windowAgents[windowId]
  }),
})
