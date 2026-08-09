import { defineApp } from '@bundled/yaar';
import App from './components/App';
import { labState } from './protocol/state';
import { runCommands } from './protocol/run';
import { notebookCommands } from './protocol/notebook';
import { exportCommands } from './protocol/export';
import { saveCurrent } from './state/persistence';
// Stylesheets are imported in cascade order — later files may override earlier ones.
import './styles/base.css';
import './styles/sidebar.css';
import './styles/shell.css';
import './styles/cells.css';
import './styles/output.css';
import './styles/table.css';
import './styles/json.css';
import './styles/chart.css';
import './styles/markdown.css';
import './styles/agent.css';

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
