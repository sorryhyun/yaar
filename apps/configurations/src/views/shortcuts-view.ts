import { createSignal, onMount, For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { listJson, invoke, del as yaarDelete } from '@bundled/yaar';
import { shortcuts, setShortcuts, showToast } from '../store';
import type { Shortcut } from '../types';

export function ShortcutsView() {
  const [label, setLabel] = createSignal('');
  const [icon, setIcon] = createSignal('🔗');
  const [shortcutType, setShortcutType] = createSignal<'skill' | 'app' | 'url'>('skill');
  const [value, setValue] = createSignal('');
  const [adding, setAdding] = createSignal(false);

  const load = async () => {
    try {
      setShortcuts(await listJson<Shortcut[]>('yaar://config/shortcuts') ?? []);
    } catch {
      setShortcuts([]);
    }
  };

  onMount(load);

  const add = async () => {
    if (!label() || !value()) { showToast('Fill all fields', 'error'); return; }
    setAdding(true);
    try {
      const payload: Record<string, string> = {
        label: label(),
        icon: icon(),
        shortcutType: shortcutType(),
      };
      if (shortcutType() === 'skill') payload.skill = value();
      else if (shortcutType() === 'app') payload.appId = value();
      else payload.url = value();

      await invoke('yaar://config/shortcuts', payload);
      setLabel(''); setIcon('🔗'); setValue('');
      await load();
      showToast('Shortcut added');
    } catch {
      showToast('Failed to add', 'error');
    } finally {
      setAdding(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await yaarDelete(`yaar://config/shortcuts/${id}`);
      await load();
      showToast('Deleted');
    } catch { showToast('Failed to delete', 'error'); }
  };

  const typeLabel = (s: Shortcut) => {
    if (s.shortcutType === 'skill') return `Skill`;
    if (s.shortcutType === 'app') return `App: ${s.appId}`;
    return `URL: ${s.url}`;
  };

  return html`
    <div>
      <p class="cfg-section-title">Desktop Shortcuts</p>
      <div class="item-list">
        <${For} each=${shortcuts}>${(s: Shortcut) => html`
          <div class="item-row">
            <div class="item-icon">${s.icon}</div>
            <div class="item-info">
              <div class="item-label">${s.label}</div>
              <div class="item-sub">${typeLabel(s)}</div>
            </div>
            <button class="item-del" onClick=${() => remove(s.id)} title="Delete">×</button>
          </div>
        `}</${For}>
      </div>

      <div class="add-card">
        <p class="add-card-title">Add Shortcut</p>
        <div class="form-grid">
          <div>
            <div class="field-label">Label</div>
            <input class="y-input" style="width:100%" placeholder="My Shortcut"
              value=${label} onInput=${(e: InputEvent) => setLabel((e.target as HTMLInputElement).value)} />
          </div>
          <div>
            <div class="field-label">Icon</div>
            <input class="y-input" style="width:100%" placeholder="🔗"
              value=${icon} onInput=${(e: InputEvent) => setIcon((e.target as HTMLInputElement).value)} />
          </div>
          <div>
            <div class="field-label">Type</div>
            <select class="y-input" style="width:100%"
              onChange=${(e: Event) => setShortcutType((e.target as HTMLSelectElement).value as 'skill' | 'app' | 'url')}>
              <option value="skill">Skill</option>
              <option value="app">App</option>
              <option value="url">URL</option>
            </select>
          </div>
          <div>
            <div class="field-label">${() => shortcutType() === 'skill' ? 'Skill Instructions' : shortcutType() === 'app' ? 'App ID' : 'URL'}</div>
            <input class="y-input" style="width:100%"
              placeholder=${() => shortcutType() === 'skill' ? 'e.g. Open the terminal' : shortcutType() === 'app' ? 'e.g. excel-lite' : 'https://...'}
              value=${value} onInput=${(e: InputEvent) => setValue((e.target as HTMLInputElement).value)} />
          </div>
        </div>
        <button class="y-btn y-btn-primary" onClick=${add} disabled=${adding}>
          ${() => adding() ? 'Adding…' : '+ Add Shortcut'}
        </button>
      </div>
    </div>
  `;
}
