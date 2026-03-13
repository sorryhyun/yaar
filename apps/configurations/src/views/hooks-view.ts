import { createSignal, onMount, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { readJson, invoke, del as yaarDelete } from '@bundled/yaar';
import { hooks, setHooks, showToast } from '../store';
import type { Hook, HookFilter, HookAction } from '../types';

const EVENTS = ['tool_use', 'launch', 'app:open', 'app:close', 'window:create', 'window:close'];

function describeFilter(filter?: HookFilter): string {
  if (!filter) return '(any)';
  const parts: string[] = [];
  if (filter.toolName) return `toolName: ${filter.toolName}`;
  if (filter.verb) parts.push(filter.verb);
  if (filter.uri) parts.push(filter.uri);
  if (filter.action) {
    const a = Array.isArray(filter.action) ? filter.action.join('|') : filter.action;
    parts.push(`→ ${a}`);
  }
  return parts.join(' ') || '(any)';
}

function describeAction(action: HookAction): string {
  if (!action) return '?';
  if (action.type === 'os_action' && action.payload) {
    const p = action.payload as Record<string, unknown>;
    const t = p['type'] as string;
    if (t === 'toast.show') return `toast: ${p['message']}`;
    if (t === 'window.create') return `window: ${p['title'] || p['windowId']}`;
    return t;
  }
  return action.type;
}

export function HooksView() {
  const [event, setEvent] = createSignal(EVENTS[0]);
  const [hookLabel, setHookLabel] = createSignal('');
  const [filterUri, setFilterUri] = createSignal('');
  const [filterAction, setFilterAction] = createSignal('');
  const [toastMsg, setToastMsg] = createSignal('');
  const [toastVariant, setToastVariant] = createSignal<'info' | 'success' | 'error'>('info');
  const [adding, setAdding] = createSignal(false);
  const [showForm, setShowForm] = createSignal(false);
  const [selected, setSelected] = createSignal<Hook | null>(null);

  const load = async () => {
    try {
      const data = await readJson<{ hooks: Hook[] }>('yaar://config/hooks');
      setHooks(data?.hooks ?? []);
    } catch {
      setHooks([]);
    }
  };

  onMount(load);

  const add = async () => {
    if (!hookLabel() || !toastMsg()) { showToast('Fill Label and Toast Message', 'error'); return; }
    setAdding(true);
    try {
      const filter: Record<string, unknown> = { verb: 'invoke' };
      if (filterUri()) filter['uri'] = filterUri();
      if (filterAction()) filter['action'] = filterAction();

      await invoke('yaar://config/hooks', {
        event: event(),
        label: hookLabel(),
        filter,
        action: {
          type: 'os_action',
          payload: {
            type: 'toast.show',
            id: `hook-${Date.now()}`,
            message: toastMsg(),
            variant: toastVariant(),
          },
        },
      });
      setHookLabel(''); setFilterUri(''); setFilterAction(''); setToastMsg('');
      setShowForm(false);
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
      setSelected(null);
      await load();
      showToast('Hook deleted');
    } catch { showToast('Failed to delete', 'error'); }
  };

  return html`
    <div class="view-panel">

      <!-- Add section at top -->
      <div class="view-add-section">
        <div class="view-add-toggle">
          <span style="font-size:13px;font-weight:600;color:var(--yaar-text)">
            🪝 Hooks
            <span style="color:var(--yaar-text-muted);font-weight:400;margin-left:4px">${() => `(${hooks().length})`}</span>
          </span>
          <button class="y-btn y-btn-sm y-btn-primary" onClick=${() => setShowForm((v: boolean) => !v)}>
            ${() => showForm() ? '✕ Cancel' : '+ New Hook'}
          </button>
        </div>
        <${Show} when=${showForm}>
          <div class="view-add-form">
            <div class="form-grid">
              <div>
                <div class="field-label">Label</div>
                <input class="y-input" style="width:100%" placeholder="My hook"
                  value=${hookLabel} onInput=${(e: InputEvent) => setHookLabel((e.target as HTMLInputElement).value)} />
              </div>
              <div>
                <div class="field-label">Event</div>
                <select class="y-input" style="width:100%"
                  onChange=${(e: Event) => setEvent((e.target as HTMLSelectElement).value)}>
                  <${For} each=${EVENTS}>${(ev: string) => html`<option value=${ev}>${ev}</option>`}</${For}>
                </select>
              </div>
              <div>
                <div class="field-label">Filter URI <span style="opacity:.6">(optional)</span></div>
                <input class="y-input" style="width:100%" placeholder="yaar://sandbox/*"
                  value=${filterUri} onInput=${(e: InputEvent) => setFilterUri((e.target as HTMLInputElement).value)} />
              </div>
              <div>
                <div class="field-label">Filter Action <span style="opacity:.6">(optional)</span></div>
                <input class="y-input" style="width:100%" placeholder="e.g. compile"
                  value=${filterAction} onInput=${(e: InputEvent) => setFilterAction((e.target as HTMLInputElement).value)} />
              </div>
              <div>
                <div class="field-label">Toast Message</div>
                <input class="y-input" style="width:100%" placeholder="Something happened!"
                  value=${toastMsg} onInput=${(e: InputEvent) => setToastMsg((e.target as HTMLInputElement).value)} />
              </div>
              <div>
                <div class="field-label">Toast Variant</div>
                <select class="y-input" style="width:100%"
                  onChange=${(e: Event) => setToastVariant((e.target as HTMLSelectElement).value as 'info' | 'success' | 'error')}>
                  <option value="info">info</option>
                  <option value="success">success</option>
                  <option value="error">error</option>
                </select>
              </div>
            </div>
            <button class="y-btn y-btn-primary" onClick=${add} disabled=${adding}>
              ${() => adding() ? 'Adding…' : '+ Add Hook'}
            </button>
          </div>
        </${Show}>
      </div>

      <!-- Sidebar + Detail -->
      <div class="view-split">
        <div class="view-sidebar">
          ${() => hooks().length === 0
            ? html`<div class="sidebar-empty">🪝 No hooks yet</div>`
            : null
          }
          <${For} each=${hooks}>${(h: Hook) => html`
            <div
              class=${() => `sidebar-item${selected()?.id === h.id ? ' active' : ''}`}
              onClick=${() => setSelected(h)}
            >
              <span class="sidebar-item-icon">🪝</span>
              <div style="flex:1;min-width:0">
                <div class="sidebar-item-label">${() => h.label}</div>
                <div class="sidebar-item-sub">${() => h.event}</div>
              </div>
            </div>
          `}</${For}>
        </div>

        <div class="view-detail">
          ${() => {
            const h = selected();
            if (!h) return html`
              <div class="detail-empty">
                <span class="detail-empty-icon">🪝</span>
                <span>Select a hook to view details</span>
              </div>
            `;
            return html`
              <div class="detail-card">
                <div class="detail-header">
                  <div class="detail-big-icon">🪝</div>
                  <div style="flex:1;min-width:0">
                    <div class="detail-title">${h.label}</div>
                    <div class="detail-title-sub" style="display:flex;gap:6px;margin-top:4px">
                      <span class="item-badge item-badge-event">${h.event}</span>
                      <span class=${h.enabled ? 'item-badge item-badge-enabled' : 'item-badge item-badge-disabled'}>
                        ${h.enabled ? '✓ enabled' : '○ disabled'}
                      </span>
                    </div>
                  </div>
                </div>
                <div class="detail-field">
                  <div class="detail-field-label">Filter</div>
                  <div class="detail-field-value">${describeFilter(h.filter)}</div>
                </div>
                <div class="detail-field">
                  <div class="detail-field-label">Action</div>
                  <div class="detail-field-value">${describeAction(h.action)}</div>
                </div>
                <div class="detail-field">
                  <div class="detail-field-label">ID</div>
                  <div class="detail-field-value" style="color:var(--yaar-text-muted);font-size:11px">${h.id}</div>
                </div>
                <div class="detail-actions">
                  <button
                    class="y-btn"
                    style="color:var(--yaar-error);border-color:var(--yaar-error)"
                    onClick=${() => remove(h.id)}
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
