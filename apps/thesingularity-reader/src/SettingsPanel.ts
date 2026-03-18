import html from '@bundled/solid-js/html';
import { settings, saveSettings } from './store';
import { startRefreshTimer } from './actions';

const INTERVALS = [
  { label: '1분', value: 60 },
  { label: '5분', value: 300 },
  { label: '10분', value: 600 },
  { label: '30분', value: 1800 },
] as const;

export function SettingsPanel() {
  return html`
    <div class="settings-overlay">
      <div class="settings-title">⚙️ 설정</div>
      <div class="settings-row">
        <span>새로고침 간갩</span>
        <select
          class="settings-select"
          value=${() => settings().refreshInterval}
          onChange=${(e: Event) => {
            const val = parseInt((e.target as HTMLSelectElement).value);
            saveSettings({ ...settings(), refreshInterval: val });
            startRefreshTimer();
          }}
        >
          ${() =>
            INTERVALS.map(
              opt => html`
                <option value=${opt.value} selected=${() => settings().refreshInterval === opt.value}>
                  ${opt.label}
                </option>
              `,
            )}
        </select>
      </div>
    </div>
  `;
}
