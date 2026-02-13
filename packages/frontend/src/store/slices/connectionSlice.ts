/**
 * Connection slice - manages WebSocket connection state.
 */
import type { SliceCreator, ConnectionSlice, ConnectionStatus } from '../types';

export const createConnectionSlice: SliceCreator<ConnectionSlice> = (set, _get) => ({
  connectionStatus: 'disconnected' as ConnectionStatus,
  connectionError: null,
  providerType: null,
  sessionId: null,

  setConnectionStatus: (status, error) =>
    set((state) => {
      state.connectionStatus = status;
      state.connectionError = error ?? null;
    }),

  setSession: (providerType, sessionId) =>
    set((state) => {
      state.providerType = providerType;
      state.sessionId = sessionId;
    }),
});
