export {};

// The data layer's public face, re-exported from the four modules it split into.
//
// Components and the protocol import from here rather than reaching into
// store.ts / fetchers.ts / streams.ts / actions.ts directly, so the boundary
// between "what the UI may touch" and "how the data layer is arranged" stays
// one file wide. The setters and the stream internals are deliberately absent:
// nothing outside the data layer should write the store.
//
//   store.ts     signals, derived views, mutators   (no I/O)
//   fetchers.ts  the three verb-API list reads      (validates, fills the store)
//   streams.ts   per-agent live activity feeds      (folds frames into the store)
//   actions.ts   the four control actions           (write, then re-read)
//   watch.ts     mount-time subscriptions + clock

export {
  activeTab,
  agentActivity,
  agentList,
  agentStats,
  appProcesses,
  lastRefresh,
  now,
  selectTab,
  windows,
} from './store';

export { refreshAll } from './fetchers';

export { closeAppWindows, closeWindow, interruptAgent, killAppAgent } from './actions';

export { startWatching } from './watch';
