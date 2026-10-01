// Entry point.
//
//   store.ts     signals: the live stream, the recording in progress, the capture list
//   actions.ts   every mutation, shared by the UI and the protocol
//   protocol.ts  the agent-facing surface
//   ui/App.ts    the view
import { defineApp } from '@bundled/yaar';
import { appCommands, appState } from './protocol';
import { App } from './ui/App';
import './styles.css';

export default defineApp({
  id: 'camera',
  name: 'Camera',
  state: { ...appState },
  commands: { ...appCommands },
  // Every command turns a device on or off, or writes a file; replaying one on a remount
  // would open a camera nobody asked for or record a second clip.
  replay: 'never',
  view: App,
});
