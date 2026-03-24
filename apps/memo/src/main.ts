export {};
import { createSignal, createMemo, Show, For, onMount, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { showToast, errMsg, onShortcut } from '@bundled/yaar';
import {
  memos, selectedId, setSelectedId,
  editMode, setEditMode,
  editTitle, setEditTitle,
  editContent, setEditContent,
  searchQuery, setSearchQuery,
  loadMemos, addMemo, updateMemo, deleteMemo,
  getFilteredMemos, getMemoById,
} from './store';
import { registerProtocol } from './protocol';
import './styles.css';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function App() {
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  const filteredMemos = createMemo(() => getFilteredMemos());
  const selectedMemo = createMemo(() => {
    const id = selectedId();
    return id ? getMemoById(id) : undefined;
  });

  function startNew() {
    setSelectedId(null);
    setEditTitle('');
    setEditContent('');
    setEditMode('new');
    setConfirmDelete(false);
  }

  function selectMemo(id: string) {
    setSelectedId(id);
    setEditMode('none');
    setConfirmDelete(false);
  }

  function startEdit() {
    const m = selectedMemo();
    if (!m) return;
    setEditTitle(m.title);
    setEditContent(m.content);
    setEditMode('edit');
    setConfirmDelete(false);
  }

  function cancelEdit() {
    setEditMode('none');
    setEditTitle('');
    setEditContent('');
    setConfirmDelete(false);
  }

  async function handleSave() {
    if (saving()) return;
    setSaving(true);
    try {
      if (editMode() === 'new') {
        const memo = await addMemo(editTitle(), editContent());
        setSelectedId(memo.id);
        setEditMode('none');
        showToast('Memo created', 'success');
      } else if (editMode() === 'edit') {
        const id = selectedId();
        if (id) {
          await updateMemo(id, editTitle(), editContent());
          setEditMode('none');
          showToast('Memo updated', 'success');
        }
      }
    } catch (err) {
      showToast(errMsg(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    const id = selectedId();
    if (!id) return;
    try {
      await deleteMemo(id);
      setConfirmDelete(false);
      showToast('Memo deleted', 'success');
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  }

  // Keyboard shortcuts
  onMount(() => {
    const unN = onShortcut('ctrl+n', () => startNew());
    const unS = onShortcut('ctrl+s', () => {
      if (editMode() !== 'none') handleSave();
    });
    const unEsc = onShortcut('escape', () => {
      if (confirmDelete()) setConfirmDelete(false);
      else if (editMode() !== 'none') cancelEdit();
    });
    onCleanup(() => { unN(); unS(); unEsc(); });
  });

  // Sidebar list item
  function MemoListItem(props: { id: string; title: string; content: string; updatedAt: string }) {
    return html`
      <div
        class=${() => `memo-list-item${selectedId() === props.id ? ' active' : ''}`}
        onClick=${() => selectMemo(props.id)}
      >
        <div class="memo-list-item-title">${() => props.title}</div>
        <div class="memo-list-item-preview">${() => props.content.slice(0, 60) || '(empty)'}</div>
        <div class="memo-list-item-date">${() => formatDate(props.updatedAt)}</div>
      </div>
    `;
  }

  // Editor panel (new or edit)
  function EditorPanel() {
    return html`
      <div class="memo-editor">
        <input
          class="memo-editor-title"
          type="text"
          placeholder="Title"
          value=${editTitle}
          onInput=${(e: InputEvent) => setEditTitle((e.target as HTMLInputElement).value)}
        />
        <textarea
          class="memo-editor-body"
          placeholder="Write your note here..."
          value=${editContent}
          onInput=${(e: InputEvent) => setEditContent((e.target as HTMLTextAreaElement).value)}
        ></textarea>
        <div class="memo-editor-actions">
          <button
            class=${() => `y-btn y-btn-primary${saving() ? ' disabled' : ''}`}
            onClick=${handleSave}
            disabled=${saving}
          >
            ${() => saving() ? 'Saving…' : 'Save'}
          </button>
          <button class="y-btn y-btn-ghost" onClick=${cancelEdit}>Cancel</button>
        </div>
      </div>
    `;
  }

  // View panel (read mode)
  function ViewPanel() {
    return html`
      <div class="memo-view">
        <div class="memo-view-header">
          <div>
            <div class="memo-view-title">${() => selectedMemo()?.title}</div>
            <div class="memo-view-meta">
              Updated ${() => selectedMemo() ? formatDate(selectedMemo()!.updatedAt) : ''}
            </div>
          </div>
          <div class="memo-view-actions">
            <button class="y-btn y-btn-sm y-btn-ghost" onClick=${startEdit}>Edit</button>
            <button class="y-btn y-btn-sm y-btn-danger" onClick=${() => setConfirmDelete(true)}>Delete</button>
          </div>
        </div>
        <div class="memo-view-body">${() => selectedMemo()?.content || '(empty)'}</div>
        <${Show} when=${confirmDelete}>
          <div class="memo-delete-confirm">
            <span>Delete this memo?</span>
            <button class="y-btn y-btn-sm y-btn-danger" onClick=${handleDelete}>Yes, delete</button>
            <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => setConfirmDelete(false)}>Cancel</button>
          </div>
        </Show>
      </div>
    `;
  }

  return html`
    <div class="memo-app">
      <!-- Toolbar -->
      <div class="memo-toolbar">
        <span class="memo-toolbar-title">📝 Memo</span>
        <input
          class="y-input memo-search"
          type="text"
          placeholder="Search…"
          value=${searchQuery}
          onInput=${(e: InputEvent) => setSearchQuery((e.target as HTMLInputElement).value)}
        />
        <button class="y-btn y-btn-primary y-btn-sm" onClick=${startNew}>+ New</button>
      </div>

      <!-- Body -->
      <div class="memo-layout">
        <!-- Sidebar -->
        <div class="memo-sidebar">
          <div class="memo-list y-scroll">
            <${Show}
              when=${() => filteredMemos().length > 0}
              fallback=${
                html`<div class="y-empty" style="padding: 24px 0">
                  <div class="memo-empty-icon">📝</div>
                  <div class="memo-empty-text">${() => searchQuery() ? 'No results' : 'No memos yet'}</div>
                </div>`
              }
            >
              <${For} each=${filteredMemos}>
                ${(m: ReturnType<typeof getFilteredMemos>[number]) =>
                  html`<${MemoListItem}
                    id=${m.id}
                    title=${m.title}
                    content=${m.content}
                    updatedAt=${m.updatedAt}
                  />`
                }
              </For>
            </Show>
          </div>
        </div>

        <!-- Main content area -->
        <div class="memo-content">
          <${Show} when=${() => editMode() !== 'none'}>
            <${EditorPanel} />
          </Show>
          <${Show} when=${() => editMode() === 'none' && selectedMemo() !== undefined}>
            <${ViewPanel} />
          </Show>
          <${Show} when=${() => editMode() === 'none' && selectedMemo() === undefined}>
            <div class="memo-empty">
              <div class="memo-empty-icon">📝</div>
              <div class="memo-empty-text">Select a memo or create a new one</div>
              <button class="y-btn y-btn-primary" onClick=${startNew}>+ New Memo</button>
            </div>
          </Show>
        </div>
      </div>
    </div>
  `;
}

render(() => {
  onMount(() => {
    loadMemos();
    registerProtocol();
  });
  return html`<${App} />`;
}, document.getElementById('app')!);
