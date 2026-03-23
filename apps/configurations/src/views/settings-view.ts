import { createSignal, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { readJson, invoke } from '@bundled/yaar';
import { showToast } from '../store';
import { parseJson, capitalize, onInputHandler, onChangeHandler } from '../helpers';

const KNOWN_KEYS = ['userName', 'language', 'onboardingCompleted', 'provider', 'wallpaper', 'accentColor', 'iconSize'];

const ACCENT_COLORS: Record<string, string> = {
  blue: '#58a6ff', lavender: '#b392f0', mauve: '#d2a8ff',
  pink: '#f778ba', peach: '#ffa28b', yellow: '#e3b341',
  green: '#3fb950', red: '#f85149',
};

const WALLPAPER_LABELS: Record<string, string> = {
  'dark-blue': '🌌 Dark Blue', midnight: '🏙️ Midnight', aurora: '🌠 Aurora',
  ember: '🔥 Ember', ocean: '🌊 Ocean', moss: '🌿 Moss',
};

export function SettingsView() {
  const [data, setData] = createSignal<Record<string, unknown>>({});
  const [extraRaw, setExtraRaw] = createSignal('');
  const [showExtra, setShowExtra] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  onMount(async () => {
    try {
      const raw = await readJson<Record<string, unknown>>('yaar://config/settings');
      const s: Record<string, unknown> = (raw as { settings?: Record<string, unknown> })?.settings ?? raw ?? {};
      setData(s);
      const extra: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s)) {
        if (!KNOWN_KEYS.includes(k)) extra[k] = v;
      }
      if (Object.keys(extra).length > 0) {
        setExtraRaw(JSON.stringify(extra, null, 2));
        setShowExtra(true);
      }
    } catch {
      setData({});
    }
  });

  const get = (key: string) => data()[key];
  const set = (key: string, value: unknown) => setData(d => ({ ...d, [key]: value }));

  const save = async () => {
    const rawStr = extraRaw().trim();
    const extra = rawStr ? parseJson<Record<string, unknown>>(rawStr, null as unknown as Record<string, unknown>) : {};
    if (rawStr && extra === null) {
      showToast('Invalid JSON in extra settings', 'error');
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const k of KNOWN_KEYS) {
        if (data()[k] !== undefined) payload[k] = data()[k];
      }
      await invoke('yaar://config/settings', { ...payload, ...(extra ?? {}) });
      showToast('Settings saved');
    } catch {
      showToast('Failed to save', 'error');
    } finally {
      setSaving(false);
    }
  };

  const Toggle = (key: string) => html`
    <button
      class=${() => `s-toggle ${get(key) ? 'on' : ''}`}
      onClick=${() => set(key, !get(key))}
      role="switch"
      aria-checked=${() => String(!!get(key))}
    >
      <span class="s-toggle-thumb"></span>
    </button>
  `;

  return html`
    <div class="settings-wrapper">
      <div class="s-section">
        <div class="s-section-title">👤 Profile</div>
        <div class="s-row">
          <label class="s-label">Display Name</label>
          <input class="s-input" type="text" placeholder="Your name"
            value=${() => String(get('userName') ?? '')}
            onInput=${onInputHandler(v => set('userName', v))}
          />
        </div>
        <div class="s-row">
          <label class="s-label">Language <span class="s-hint">e.g. en, ko, ja</span></label>
          <input class="s-input" type="text" placeholder="en"
            value=${() => String(get('language') ?? 'en')}
            onInput=${onInputHandler(v => set('language', v))}
          />
        </div>
      </div>

      <div class="s-section">
        <div class="s-section-title">🎨 Appearance</div>
        <div class="s-row">
          <label class="s-label">Wallpaper</label>
          <select class="s-select"
            value=${() => String(get('wallpaper') ?? '')}
            onChange=${onChangeHandler(v => set('wallpaper', v))}
          >
            ${Object.entries(WALLPAPER_LABELS).map(([val, label]) =>
              html`<option value=${val}>${label}</option>`
            )}
          </select>
        </div>
        <div class="s-row">
          <label class="s-label">Accent Color</label>
          <div class="s-accent-picker">
            ${() => Object.keys(ACCENT_COLORS).map(color => html`
              <button
                class=${() => `s-accent-swatch ${get('accentColor') === color ? 'active' : ''}`}
                style=${`background: ${ACCENT_COLORS[color]}`}
                title=${color}
                onClick=${() => set('accentColor', color)}
              ></button>
            `)}
          </div>
        </div>
        <div class="s-row">
          <label class="s-label">Icon Size</label>
          <select class="s-select"
            value=${() => String(get('iconSize') ?? '')}
            onChange=${onChangeHandler(v => set('iconSize', v))}
          >
            ${['small', 'medium', 'large'].map(v =>
              html`<option value=${v}>${capitalize(v)}</option>`
            )}
          </select>
        </div>
      </div>

      <div class="s-section">
        <div class="s-section-title">⚙️ System</div>
        <div class="s-row">
          <label class="s-label">AI Provider <span class="s-hint">Reload required</span></label>
          <select class="s-select"
            value=${() => String(get('provider') ?? '')}
            onChange=${onChangeHandler(v => set('provider', v))}
          >
            ${['auto', 'claude', 'codex'].map(v =>
              html`<option value=${v}>${capitalize(v)}</option>`
            )}
          </select>
        </div>
        <div class="s-row s-row-toggle">
          <div>
            <label class="s-label">Onboarding Completed</label>
            <div class="s-hint-block">Mark first-run setup as done</div>
          </div>
          ${() => Toggle('onboardingCompleted')}
        </div>
      </div>

      <div class="s-section">
        <button class="s-extra-toggle" onClick=${() => setShowExtra(v => !v)}>
          ${() => showExtra() ? '▾' : '▸'} Advanced / Extra Settings
          ${() => extraRaw().trim() ? html`<span class="s-extra-badge">${() => Object.keys(parseJson(extraRaw(), {})).length} keys</span>` : ''}
        </button>
        ${() => showExtra() ? html`
          <textarea
            class="settings-editor"
            style="margin-top: 8px; min-height: 120px;"
            value=${extraRaw}
            onInput=${(e: InputEvent) => setExtraRaw((e.target as HTMLTextAreaElement).value)}
            placeholder="{}"
          ></textarea>
          <p class="s-hint-block" style="margin-top:4px;">Unknown or custom keys (raw JSON)</p>
        ` : ''}
      </div>

      <div style="padding: 0 0 16px;">
        <button class="y-btn y-btn-primary" onClick=${save} disabled=${saving}>
          ${() => saving() ? 'Saving…' : 'Save Settings'}
        </button>
      </div>
    </div>
  `;
}
