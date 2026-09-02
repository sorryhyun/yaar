import html from '@bundled/solid-js/html';
import { defineApp } from '@bundled/yaar';
import './styles/index';
import { activeTab, setActiveTab } from './store';
import type { Tab } from './types';
import { SettingsView, ShortcutsView, HooksView, DomainsView, UpdatesView } from './views/index';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'settings', label: 'Settings', icon: '⚙️' },
  { id: 'shortcuts', label: 'Shortcuts', icon: '⚡' },
  { id: 'hooks', label: 'Hooks', icon: '🪝' },
  { id: 'domains', label: 'Domains', icon: '🌐' },
  { id: 'updates', label: 'Updates', icon: '📦' },
];

function shiftTab(delta: number) {
  const idx = TABS.findIndex((t) => t.id === activeTab());
  setActiveTab(TABS[(idx + delta + TABS.length) % TABS.length].id);
}

function App() {
  return html`
    <div class="cfg-layout">
      <div class="y-tabs cfg-tabs">
        ${TABS.map(
          (tab) => html`
          <button
            class=${() => `y-tab${activeTab() === tab.id ? ' active' : ''}`}
            onClick=${() => setActiveTab(tab.id)}
          >
            ${tab.icon} ${tab.label}
          </button>
        `,
        )}
      </div>

      <div class="cfg-content">
        ${() =>
          activeTab() === 'settings'
            ? SettingsView()
            : activeTab() === 'shortcuts'
              ? ShortcutsView()
              : activeTab() === 'hooks'
                ? HooksView()
                : activeTab() === 'updates'
                  ? UpdatesView()
                  : DomainsView()}
      </div>


    </div>
  `;
}

export default defineApp({
  id: 'configurations',
  name: 'Configurations',
  state: {
    activeTab: {
      description:
        'The settings tab currently shown: settings, shortcuts, hooks, domains, or updates.',
      get: () => activeTab(),
    },
  },
  commands: {
    openTab: {
      description: 'Switch to a settings tab.',
      params: {
        type: 'object',
        properties: {
          tab: {
            type: 'string',
            enum: ['settings', 'shortcuts', 'hooks', 'domains', 'updates'],
            description: 'The tab to show.',
          },
        },
        required: ['tab'],
      },
      run: (p) => {
        const tab = p.tab as Tab;
        if (!TABS.some((t) => t.id === tab)) {
          throw new Error(
            `Unknown tab "${String(p.tab)}" - expected ${TABS.map((t) => t.id).join(' | ')}`,
          );
        }
        setActiveTab(tab);
      },
    },
    nextTab: {
      description: 'Cycle to the next settings tab. Also bound to ArrowRight.',
      replay: 'never',
      run: () => shiftTab(1),
    },
    prevTab: {
      description: 'Cycle to the previous settings tab. Also bound to ArrowLeft.',
      replay: 'never',
      run: () => shiftTab(-1),
    },
  },
  keybindings: {
    ArrowRight: 'nextTab',
    ArrowLeft: 'prevTab',
  },
  view: App,
});
