import { createSignal, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { readJson, invoke } from '@bundled/yaar';
import { showToast } from '../store';

export function SettingsView() {
  const [raw, setRaw] = createSignal('');
  const [saving, setSaving] = createSignal(false);

  onMount(async () => {
    try {
      const settings = await readJson<Record<string, unknown>>('yaar://config/settings');
      setRaw(JSON.stringify(settings ?? {}, null, 2));
    } catch {
      setRaw('{}');
    }
  });

  const save = async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw()); }
    catch { showToast('Invalid JSON', 'error'); return; }
    setSaving(true);
    try {
      await invoke('yaar://config/settings', parsed as Record<string, unknown>);
      showToast('Settings saved');
    } catch {
      showToast('Failed to save', 'error');
    } finally {
      setSaving(false);
    }
  };

  return html`
    <div class="settings-wrapper">
      <p class="cfg-section-title">⚙️ System Settings</p>
      <textarea
        class="settings-editor"
        value=${raw}
        onInput=${(e: InputEvent) => setRaw((e.target as HTMLTextAreaElement).value)}
      ></textarea>
      <div style="margin-top: 12px; display: flex; gap: 8px;">
        <button class="y-btn y-btn-primary" onClick=${save} disabled=${saving}>
          ${() => saving() ? 'Saving…' : 'Save Settings'}
        </button>
      </div>
    </div>
  `;
}
