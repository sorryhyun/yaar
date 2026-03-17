export {};
import { createSignal, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { openFilePath, openFileContent, writeFile } from './project';

const [isDirty, setIsDirty] = createSignal(false);
const [localContent, setLocalContent] = createSignal<string>('');
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const path = openFilePath();
    if (path && isDirty()) {
      writeFile(path, localContent());
      setIsDirty(false);
    }
  }, 1000);
}

function saveNow() {
  if (saveTimer) clearTimeout(saveTimer);
  const path = openFilePath();
  if (path && isDirty()) {
    writeFile(path, localContent());
    setIsDirty(false);
  }
}

export function Editor() {
  return html`
    <div class="editor">
      <${Show}
        when=${() => openFilePath()}
        fallback=${html`
          <div class="editor-empty y-text-sm y-text-muted">Select a file to view</div>
        `}
      >
        <div class="editor-header y-text-xs y-text-muted">
          ${() => openFilePath()}
          <${Show} when=${isDirty}>
            <span class="dirty-dot"></span>
          <//>
        </div>
        <div class="editor-content">
          <textarea
            class="editor-textarea"
            spellcheck=${false}
            value=${() => {
              // Sync from external content changes (agent writes, file open)
              const content = openFileContent() ?? '';
              if (!isDirty()) setLocalContent(content);
              return isDirty() ? localContent() : content;
            }}
            onInput=${(e: Event) => {
              const val = (e.target as HTMLTextAreaElement).value;
              setLocalContent(val);
              setIsDirty(true);
              scheduleSave();
            }}
            onKeyDown=${(e: KeyboardEvent) => {
              // Ctrl+S / Cmd+S — immediate save
              if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                saveNow();
              }
              // Tab — insert 2 spaces
              if (e.key === 'Tab') {
                e.preventDefault();
                const ta = e.target as HTMLTextAreaElement;
                const start = ta.selectionStart;
                const end = ta.selectionEnd;
                const val = ta.value;
                ta.value = val.substring(0, start) + '  ' + val.substring(end);
                ta.selectionStart = ta.selectionEnd = start + 2;
                setLocalContent(ta.value);
                setIsDirty(true);
                scheduleSave();
              }
            }}
          ></textarea>
        </div>
      <//>
    </div>
  `;
}
