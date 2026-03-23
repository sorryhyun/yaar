import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { activeTab, setActiveTab } from './store';
import type { Tab } from './types';
import { SettingsView } from './views/settings-view';
import { ShortcutsView } from './views/shortcuts-view';
import { HooksView } from './views/hooks-view';
import { DomainsView } from './views/domains-view';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'settings', label: 'Settings', icon: '⚙️' },
  { id: 'shortcuts', label: 'Shortcuts', icon: '⚡' },
  { id: 'hooks', label: 'Hooks', icon: '🪝' },
  { id: 'domains', label: 'Domains', icon: '🌐' },
];

function App() {
  return html`
    <div class="cfg-layout">
      <div class="cfg-tabs">
        ${TABS.map(tab => html`
          <button
            class=${() => `cfg-tab${activeTab() === tab.id ? ' active' : ''}`}
            onClick=${() => setActiveTab(tab.id)}
          >
            ${tab.icon} ${tab.label}
          </button>
        `)}
      </div>

      <div class="cfg-content">
        ${() => activeTab() === 'settings' ? SettingsView() :
                 activeTab() === 'shortcuts' ? ShortcutsView() :
                 activeTab() === 'hooks' ? HooksView() :
                 DomainsView()}
      </div>


    </div>
  `;
}

render(App, document.getElementById('app')!);
