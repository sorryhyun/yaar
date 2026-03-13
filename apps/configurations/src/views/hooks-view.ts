import { createSignal, onMount, For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { listJson, invoke, del as yaarDelete } from '@bundled/yaar';
import { hooks, setHooks, showToast } from '../store';
import type { Hook } from '../types';

const EVENTS = ['app:open', 'app:close', 'session:start', 'window:create', 'window:close'];

export function HooksView() {
  const [event, setEvent] = createSignal(EVENTS[0]);
  const [action, setAction] = createSignal('');
  const [hookLabel, setHookLabel] = createSignal('');
  const [adding, setAdding] = createSignal(false);

  const load = async () => {
    try {
      setHooks(await listJson<Hook[]>('yaar://config/hooks') ?? []);
    } catch {
      setHooks([]);
    }
  };

  onMount(load);

  const add = async () => {
    if (!action() || !hookLabel()) { showToast('Fill all fields', 'error'); return; }
    setAdding(true);
    try {
      await invoke('yaar://config/hooks', { event: event(), action: action(), label: hookLabel() });
      setAction(''); setHookLabel('');
      await load();
      showToast('Hook added');
    } catch {
      showToast('Failed to add', 'error');
    } finally {
      setAdding(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await yaarDelete(`yaar://config/hooks/${id}`);
      await load();
      showToast('Hook deleted');
    } catch { showToast('Failed to delete', 'error'); }
  };

  return html`
    <div>
      <p class="cfg-section-title">Event Hooks</p>
      <div class="item-list">
        <${For} each=${hooks}>${(h: Hook) => html`
          <div class="item-row">
            <div class="item-icon">🪝</div>
            <div class="item-info">
              <div class="item-label">${h.label}</div>
              <div class="item-sub">${h.event} → ${h.action}</div>
            </div>
            <button class="item-del" onClick=${() => remove(h.id)} title="Delete">×</button>
          </div>
        `}</${For}>
      </div>

      <div class="add-card">
        <p class="add-card-title">Add Hook</p>
        <div class="form-grid">
          <div>
            <div class="field-label">Event</div>
            <select class="y-input" style="width:100%"
              onChange=${(e: Event) => setEvent((e.target as HTMLSelectElement).value)}>
              <${For} each=${EVENTS}>${(ev: string) => html`<option value=${ev}>${ev}</option>`}</${For}>
            </select>
          </div>
          <div>
            <div class="field-label">Label</div>
            <input class="y-input" style="width:100%" placeholder="My hook"
              value=${hookLabel} onInput=${(e: InputEvent) => setHookLabel((e.target as HTMLInputElement).value)} />
          </div>
          <div class="form-full">
            <div class="field-label">Action (AI instruction to run)</div>
            <input class="y-input" style="width:100%" placeholder="e.g. Open the terminal app"
              value=${action} onInput=${(e: InputEvent) => setAction((e.target as HTMLInputElement).value)} />
          </div>
        </div>
        <button class="y-btn y-btn-primary" onClick=${add} disabled=${adding}>
          ${() => adding() ? 'Adding…' : '+ Add Hook'}
        </button>
      </div>
    </div>
  `;
}
