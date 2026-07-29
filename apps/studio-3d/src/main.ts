import { defineApp } from '@bundled/yaar';
import './styles.css';
import { App } from './ui/App';
import { appState, editCommands, loadCommands, viewCommands } from './protocol';

export default defineApp({
  id: 'studio-3d',
  name: '3D Studio',
  state: appState,
  commands: {
    ...loadCommands,
    ...editCommands,
    ...viewCommands,
  },
  keybindings: {
    f: 'frameSelection',
    a: 'frameAll',
    g: 'toggleGrid',
    w: 'toggleWireframe',
    Delete: 'deleteSelected',
    'Ctrl+z': 'undo',
    'Ctrl+y': 'redo',
  },
  view: App,
});
