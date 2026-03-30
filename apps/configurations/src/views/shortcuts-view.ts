import { createSignal, createMemo, onMount, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { invoke, del as yaarDelete } from '@bundled/yaar';
import { shortcuts, setShortcuts, showToast } from '../store';
import type { Shortcut } from '../types';
import { onInputHandler } from '../helpers';
import { loadConfigList } from '../api';

export function ShortcutsView() {
  // ── Add-form fields ──────────────────────────────────────
  const [label, setLabel] = createSignal('');
  const [icon, setIcon] = createSignal('🔗');
  const [target, setTarget] = createSignal('');
  const [formFolder, setFormFolder] = createSignal('');
  const [adding, setAdding] = createSignal(false);
  const [showForm, setShowForm] = createSignal(false);

  // ── Selection & edit ─────────────────────────────────────
  const [selected, setSelected] = createSignal<Shortcut | null>(null);
  const [editFolder, setEditFolder] = createSignal('');
  const [savingFolder, setSavingFolder] = createSignal(false);

  // ── Folder management ────────────────────────────────────
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [extraFolders, setExtraFolders] = createSignal<string[]>([]);
  const [showNewFolderInput, setShowNewFolderInput] = createSignal(false);
  const [newFolderName, setNewFolderName] = createSignal('');

  // ── Data loading ─────────────────────────────────────────
  const load = () => loadConfigList<Shortcut>('yaar://config/shortcuts', 'shortcuts', setShortcuts);
  onMount(load);

  // ── Derived: all folder names ─────────────────────────────
  const folderNames = createMemo(() => {
    const fromShortcuts = shortcuts()
      .map(s => s.folderId)
      .filter((f): f is string => !!f);
    const all = new Set([...fromShortcuts, ...extraFolders()]);
    return Array.from(all).sort();
  });

  // ── Derived: grouped shortcuts ────────────────────────────
  const grouped = createMemo(() => {
    const sc = shortcuts();
    const folderGroups = folderNames().map(folderId => ({
      folderId,
      items: sc.filter(s => s.folderId === folderId),
    }));
    const ungrouped = sc.filter(s => !s.folderId);
    return { folderGroups, ungrouped };
  });

  // ── Helpers ───────────────────────────────────────────────
  const isCollapsed = (folderId: string) => collapsed().has(folderId);

  const toggleCollapse = (folderId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
      return next;
    });
  };

  const selectShortcut = (s: Shortcut) => {
    setSelected(s);
    setEditFolder(s.folderId ?? '');
  };

  // ── Actions ───────────────────────────────────────────────
  const add = async () => {
    if (!label() || !target()) { showToast('Fill all fields', 'error'); return; }
    setAdding(true);
    try {
      const payload: Record<string, unknown> = { label: label(), icon: icon(), target: target() };
      if (formFolder().trim()) payload.folderId = formFolder().trim();
      await invoke('yaar://config/shortcuts', payload);
      setLabel(''); setIcon('🔗'); setTarget(''); setFormFolder('');
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

  const saveFolder = async () => {
    const s = selected();
    if (!s) return;
    setSavingFolder(true);
    try {
      const folderId = editFolder().trim() || null;
      await invoke('yaar://config/shortcuts', { id: s.id, folderId });
      await load();
      const updated = shortcuts().find(sc => sc.id === s.id);
      if (updated) setSelected(updated);
      showToast('Folder updated');
    } catch {
      showToast('Failed to update folder', 'error');
    } finally {
      setSavingFolder(false);
    }
  };

  const createFolder = () => {
    const name = newFolderName().trim();
    if (!name) return;
    if (folderNames().includes(name)) { showToast('Folder already exists', 'error'); return; }
    setExtraFolders(prev => [...prev, name]);
    setNewFolderName('');
    setShowNewFolderInput(false);
    showToast(`Folder "${name}" created`);
  };

  const deleteFolder = async (folderId: string) => {
    const inFolder = shortcuts().filter(s => s.folderId === folderId);
    try {
      await Promise.all(
        inFolder.map(s => invoke('yaar://config/shortcuts', { id: s.id, folderId: null }))
      );
      setExtraFolders(prev => prev.filter(f => f !== folderId));
      const sel = selected();
      if (sel?.folderId === folderId) setSelected(null);
      await load();
      showToast(`Folder "${folderId}" removed`);
    } catch {
      showToast('Failed to remove folder', 'error');
    }
  };

  // ── Render ────────────────────────────────────────────────
  return html`
    <div class="view-panel">

      <!-- ── Top toolbar ── -->
      <div class="view-add-section">
        <div class="view-add-toggle">
          <span style="font-size:13px;font-weight:600;color:var(--yaar-text)">
            ⚡ Shortcuts
            <span style="color:var(--yaar-text-muted);font-weight:400;margin-left:4px">${() => `(${shortcuts().length})`}</span>
          </span>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="y-btn y-btn-sm" onClick=${() => { setShowNewFolderInput((v: boolean) => !v); setShowForm(false); }}>
              ${() => showNewFolderInput() ? '✕ Cancel' : '📁 New Folder'}
            </button>
            <button class="y-btn y-btn-sm y-btn-primary" onClick=${() => { setShowForm((v: boolean) => !v); setShowNewFolderInput(false); }}>
              ${() => showForm() ? '✕ Cancel' : '+ New Shortcut'}
            </button>
          </div>
        </div>

        <!-- New Folder input -->
        <${Show} when=${showNewFolderInput}>
          <div class="folder-create-row">
            <input class="y-input" style="flex:1;min-width:0" placeholder="Folder name…"
              value=${newFolderName}
              onInput=${onInputHandler(setNewFolderName)}
              onKeyDown=${(e: KeyboardEvent) => { if (e.key === 'Enter') createFolder(); }} />
            <button class="y-btn y-btn-sm y-btn-primary" onClick=${createFolder}>Create</button>
          </div>
        </${Show}>

        <!-- Add Shortcut form -->
        <${Show} when=${showForm}>
          <div class="view-add-form">
            <div class="form-grid">
              <div>
                <div class="field-label">Label</div>
                <input class="y-input" style="width:100%" placeholder="My Shortcut"
                  value=${label} onInput=${onInputHandler(setLabel)} />
              </div>
              <div>
                <div class="field-label">Icon (emoji)</div>
                <input class="y-input" style="width:100%" placeholder="🔗"
                  value=${icon} onInput=${onInputHandler(setIcon)} />
              </div>
              <div class="form-full">
                <div class="field-label">Target URI</div>
                <input class="y-input" style="width:100%" placeholder="yaar://apps/my-app"
                  value=${target} onInput=${onInputHandler(setTarget)} />
              </div>
              <div class="form-full">
                <div class="field-label">Folder (optional)</div>
                <input class="y-input" style="width:100%" placeholder="None (ungrouped)"
                  list="sc-folder-list"
                  value=${formFolder} onInput=${onInputHandler(setFormFolder)} />
                <datalist id="sc-folder-list">
                  <${For} each=${folderNames}>${(f: string) => html`<option value=${f} />`}</${For}>
                </datalist>
              </div>
            </div>
            <button class="y-btn y-btn-primary" onClick=${add} disabled=${adding}>
              ${() => adding() ? 'Adding…' : '+ Add Shortcut'}
            </button>
          </div>
        </${Show}>
      </div>

      <!-- ── Body: sidebar + detail ── -->
      <div class="view-split">

        <!-- Sidebar -->
        <div class="view-sidebar">
          ${() => shortcuts().length === 0 && folderNames().length === 0
            ? html`<div class="sidebar-empty">⚡ No shortcuts yet</div>`
            : null
          }

          <!-- Folder groups -->
          <${For} each=${folderNames}>${(folderId: string) => {
            const getItems = () =>
              grouped().folderGroups.find(g => g.folderId === folderId)?.items ?? [];
            return html`
              <div class="folder-group">
                <div class="folder-header" onClick=${() => toggleCollapse(folderId)}>
                  <span class="folder-arrow">${() => isCollapsed(folderId) ? '▶' : '▼'}</span>
                  <span class="folder-hicon">📁</span>
                  <span class="folder-hname">${folderId}</span>
                  <span class="folder-hcount">${() => getItems().length}</span>
                  <button
                    class="folder-del-btn"
                    title="Delete folder"
                    onClick=${(e: Event) => { e.stopPropagation(); deleteFolder(folderId); }}
                  >✕</button>
                </div>
                <${Show} when=${() => !isCollapsed(folderId)}>
                  <${For} each=${getItems}>${(s: Shortcut) => html`
                    <div
                      class=${() => `y-list-item sidebar-item sc-item-indented${selected()?.id === s.id ? ' active' : ''}`}
                      onClick=${() => selectShortcut(s)}
                    >
                      <span class="sidebar-item-icon">${() => s.icon}</span>
                      <span class="sidebar-item-label">${() => s.label}</span>
                    </div>
                  `}</${For}>
                </${Show}>
              </div>
            `;
          }}</${For}>

          <!-- Ungrouped section -->
          ${() => grouped().ungrouped.length > 0
            ? html`
              <div class="folder-group">
                <div class="folder-header folder-header-ungrouped" onClick=${() => toggleCollapse('__ungrouped__')}>
                  <span class="folder-arrow">${() => isCollapsed('__ungrouped__') ? '▶' : '▼'}</span>
                  <span class="folder-hicon" style="opacity:0.4">·</span>
                  <span class="folder-hname" style="color:var(--yaar-text-muted)">Ungrouped</span>
                  <span class="folder-hcount">${() => grouped().ungrouped.length}</span>
                </div>
                <${Show} when=${() => !isCollapsed('__ungrouped__')}>
                  <${For} each=${() => grouped().ungrouped}>${(s: Shortcut) => html`
                    <div
                      class=${() => `y-list-item sidebar-item sc-item-indented${selected()?.id === s.id ? ' active' : ''}`}
                      onClick=${() => selectShortcut(s)}
                    >
                      <span class="sidebar-item-icon">${() => s.icon}</span>
                      <span class="sidebar-item-label">${() => s.label}</span>
                    </div>
                  `}</${For}>
                </${Show}>
              </div>
            `
            : null
          }
        </div>

        <!-- Detail panel -->
        <div class="view-detail">
          ${() => {
            const s = selected();
            if (!s) return html`
              <div class="y-empty detail-empty">
                <span class="y-empty-icon detail-empty-icon">⚡</span>
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
                  <div class="y-label detail-field-label">Target URI</div>
                  <div class="detail-field-value">${s.target}</div>
                </div>

                <div class="detail-field">
                  <div class="y-label detail-field-label">ID</div>
                  <div class="detail-field-value" style="color:var(--yaar-text-muted)">${s.id}</div>
                </div>

                <!-- Folder assignment -->
                <div class="detail-field">
                  <div class="y-label detail-field-label">Folder</div>
                  <div class="sc-folder-row">
                    <input
                      class="y-input sc-folder-input"
                      placeholder="None (ungrouped)"
                      list="sc-folder-list-detail"
                      value=${editFolder}
                      onInput=${onInputHandler(setEditFolder)}
                    />
                    <datalist id="sc-folder-list-detail">
                      <${For} each=${folderNames}>${(f: string) => html`<option value=${f} />`}</${For}>
                    </datalist>
                    <button
                      class="y-btn y-btn-sm y-btn-primary"
                      onClick=${saveFolder}
                      disabled=${savingFolder}
                    >${() => savingFolder() ? '…' : 'Save'}</button>
                  </div>
                  ${() => s.folderId
                    ? html`<div class="sc-folder-current">Current: <strong>${s.folderId}</strong></div>`
                    : html`<div class="sc-folder-current" style="color:var(--yaar-text-muted)">Currently ungrouped</div>`
                  }
                </div>

                <div class="detail-actions">
                  <button class="y-btn y-btn-danger" onClick=${() => remove(s.id)}>
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
