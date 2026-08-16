export {};

// Entry point. Everything real lives one level down:
//
//   components/  the view, one file per tab plus the shared list shell
//   protocol.ts  the agent-facing state keys and commands
//   data.ts      the data layer's public face (store, fetchers, streams, actions)
//   format.ts    pure display formatters
//   theme.ts     the two runtime-value → colour tables
//   constants.ts every repeated URI, tier name and threshold

import { defineApp } from '@bundled/yaar';
import { App } from './components/App';
import { appCommands, appState } from './protocol';
import './styles/index';

export default defineApp({
  // Spelled out rather than imported from constants.ts: the compiler reads this
  // object statically to build the manifest, so `id` must be a literal.
  id: 'process-explorer',
  name: 'Process Explorer',
  state: { ...appState },
  commands: { ...appCommands },
  view: App,
});
