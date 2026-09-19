// Entry point.
//
//   gateway.ts   /api/remote-control — status, start, stop
//   store.ts     the status signal and the name field
//   actions.ts   every mutation, shared by the UI and the protocol
//   protocol.ts  the agent-facing surface
//   ui/App.ts    the view
import { defineApp } from '@bundled/yaar';
import { appCommands, appState } from './protocol';
import { App } from './ui/App';
import './styles.css';

export default defineApp({
  id: 'remote-control',
  name: 'Remote Control',
  state: { ...appState },
  commands: { ...appCommands },
  view: App,
});
