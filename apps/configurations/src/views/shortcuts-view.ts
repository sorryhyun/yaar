import { createSignal, onMount, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { readJson, invoke, del as yaarDelete } from '@bundled/yaar';
import { shortcuts, setShortcuts, showToast } from '../store';
import type { Shortcut } from '../types';

export function ShortcutsView() {
  const [label, setLabel] = createSignal('');
  const [icon, setIcon] = createSignal('🔗');
  const [target, setTarget] = createSignal('');
  const [adding, setAdding] = createSignal(false);
  const [showForm, setShowForm] = createSignal(false);
  const [selected, setSelected] = createSignal<Shortcut | null>(null);

  const load = async () => {
    try {
      const data = await readJson<{ shortcuts: Shortcut[] }>('yaar://config/shortcuts');
      setShortcuts(data?.shortcuts ?? []);
    } catch {
      setShortcuts([]);
    }
  };

  onMount(load);

  const add = async () => {
    if (!label() || !target()) { showToast('Fill all fields', 'error'); return; }
    setAdding(true);
    try {
      await invoke('yaar://config/shortcuts', { label: label(), icon: icon(), target: target() });
      setLabel(''); setIcon('🔗'); setTarget('');
      setShowForm(false);
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
      setSelected(null);
      await load();
      showToast('Deleted');
    } catch { showToast('Failed to delete', 'error'); }
  };

  return html`
    <div class="view-panel">

      <!-- Add section at top -->
      <div class="view-add-section">
        <div class="view-add-toggle">
          <span style="font-size:13px;font-weight:600;color:var(--yaar-text)">
            ⚡ Shortcuts
            <span style="color:var(--yaar-text-muted);font-weight:400;margin-left:4px">${() => `(${shortcuts().length})`}</span>
          </span>
          <button class="y-btn y-btn-sm y-btn-primary" onClick=${() => setShowForm((v: boolean) => !v)}>
            ${() => showForm() ? '✕ Cancel' : '+ New Shortcut'}
          </button>
        </div>
        <${Show} when=${showForm}>
          <div class="view-add-form">
            <div class="form-grid">
              <div>
                <div class="field-label">Label</div>
                <input class="y-input" style="width:100%" placeholder="My Shortcut"
                  value=${label} onInput=${(e: InputEvent) => setLabel((e.target as HTMLInputElement).value)} />
              </div>
              <div>
                <div class="field-label">Icon (emoji)</div>
                <input class="y-input" style="width:100%" placeholder="🔗"
                  value=${icon} onInput=${(e: InputEvent) => setIcon((e.target as HTMLInputElement).value)} />
              </div>
              <div class="form-full">
                <div class="field-label">Target URI</div>
                <input class="y-input" style="width:100%" placeholder="yaar://apps/my-app"
                  value=${target} onInput=${(e: InputEvent) => setTarget((e.target as HTMLInputElement).value)} />
              </div>
            </div>
            <button class="y-btn y-btn-primary" onClick=${add} disabled=${adding}>
              ${() => adding() ? 'Adding…' : '+ Add Shortcut'}
            </button>
          </div>
        </${Show}>
      </div>

      <!-- Sidebar + Detail -->
      <div class="view-split">
        <div class="view-sidebar">
          ${() => shortcuts().length === 0
            ? html`<div class="sidebar-empty">⚡ No shortcuts yet</div>`
            : null
          }
          <${For} each=${shortcuts}>${(s: Shortcut) => html`
            <div
              class=${() => `sidebar-item${selected()?.id === s.id ? ' active' : ''}`}
              onClick=${() => setSelected(s)}
            >
              <span class="sidebar-item-icon">${() => s.icon}</span>
              <span class="sidebar-item-label">${() => s.label}</span>
            </div>
          `}</${For}>
        </div>

        <div class="view-detail">
          ${() => {
            const s = selected();
            if (!s) return html`
              <div class="detail-empty">
                <span class="detail-empty-icon">⚡</span>
                <span>Select a shortcut to view details</span>
              </div>
            `;
            return html`
              <div class="detail-card">
                <div class="detail-header">
                  <div class="detail-big-icon">${s.icon}</div>
                  <div>
                    <div class="detail-title">${s.label}</div>
                    <div class="detail-title-sub">Desktop Shortcut</div>
                  </div>
                </div>
                <div class="detail-field">
                  <div class="detail-field-label">Target URI</div>
                  <div class="detail-field-value">${s.target}</div>
                </div>
                <div class="detail-field">
                  <div class="detail-field-label">ID</div>
                  <div class="detail-field-value" style="color:var(--yaar-text-muted)">${s.id}</div>
                </div>
                <div class="detail-actions">
                  <button
                    class="y-btn"
                    style="color:var(--yaar-error);border-color:var(--yaar-error)"
                    onClick=${() => remove(s.id)}
                  >
                    🗑 Delete
                  </button>
                </div>
              </div>
            `;
          }}
        </div>
      </div>
    </div>
  `;
}
