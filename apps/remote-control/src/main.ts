// Entry point.
//
//   gateway.ts   yaar://system/remote-control — read, start, write, stop
//   store.ts     the host status signal and form fields
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
