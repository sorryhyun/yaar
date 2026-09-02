import { For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { showConfirm, tryToast } from '@bundled/yaar';
import { deleteNotebook, newNotebook, openNotebook, saveCurrent } from '../state/persistence';
import { current, notebooks } from '../state/signals';

/** The notebook list. Switching notebooks always saves the open one first. */
export function Sidebar() {
  return html`
    <div class="lab-sidebar">
      <div class="y-toolbar lab-side-head">
        <span class="lab-side-title">Notebooks</span>
        <button class="lab-mini" title="New notebook" onClick=${async () => {
          await saveCurrent();
          await newNotebook('Untitled');
        }}>+</button>
      </div>
      <div class="lab-side-list">
        <${For} each=${notebooks}>
          ${(m: { id: string; title: string; cellCount: number; updatedAt: number }) => html`
            <div
              class=${() => 'lab-side-item' + (current()?.id === m.id ? ' lab-side-item-on' : '')}
              onClick=${async () => {
                if (current()?.id === m.id) return;
                await saveCurrent();
                await tryToast(() => openNotebook(m.id));
              }}
            >
              <div class="lab-side-name">${m.title}</div>
              <div class="lab-side-meta">${m.cellCount} cells · ${new Date(m.updatedAt).toLocaleDateString()}</div>
              <button
                class="lab-side-del"
                title="Delete notebook"
                onClick=${async (e: MouseEvent) => {
                  e.stopPropagation();
                  if (
                    await showConfirm('Delete "' + m.title + '"?', {
                      danger: true,
                      okLabel: 'Delete',
                    })
                  ) {
                    await deleteNotebook(m.id);
                  }
                }}
              >✕</button>
            </div>`}
        <//>
      </div>
    </div>`;
}
