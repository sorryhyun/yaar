import { defineApp } from '@bundled/yaar';
import App from './components/App';
import { labState } from './protocol/state';
import { runCommands } from './protocol/run';
import { notebookCommands } from './protocol/notebook';
import { exportCommands } from './protocol/export';
import { saveCurrent } from './state/persistence';
import './styles/index';

export default defineApp({
  id: 'lab',
  name: 'Lab',
  state: labState,
  commands: { ...runCommands, ...notebookCommands, ...exportCommands },
  view: App,
  onClose: () => {
    void saveCurrent();
  },
});
