import { createEffect } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { activeTab, setActiveTab, toast } from './store';
import { SettingsView } from './views/settings-view';
import { ShortcutsView } from './views/shortcuts-view';
import { HooksView } from './views/hooks-view';
import { DomainsView } from './views/domains-view';

type Tab = 'settings' | 'shortcuts' | 'hooks' | 'domains';

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
            onClick=${() => setActiveTab(tab.id as any)}
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

      ${() => {
        const t = toast();
        if (!t) return null;
        return html`<div class=${`cfg-toast cfg-toast-${t.type}`}>${t.msg}</div>`;
      }}
    </div>
  `;
}

render(App, document.getElementById('app')!);
