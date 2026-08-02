import { defineApp } from '@bundled/yaar';
import App from './App';
import { labState, runCommands } from './protocol';
import { notebookCommands } from './protocol-nb';
import { saveCurrent } from './store';
import './styles.css';

export default defineApp({
  id: 'lab',
  name: 'Lab',
  state: labState,
  commands: { ...runCommands, ...notebookCommands },
  view: App,
  onClose: () => {
    void saveCurrent();
  },
});
