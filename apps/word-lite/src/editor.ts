import { countTextStats, DEFAULT_TITLE } from './utils';
import { editorEl, focusMode, setFocusMode, setStatsText, setSaveStateText, fileInputEl, docTitleEl } from './state';

export const refreshStats = () => {
  const { words, chars } = countTextStats(editorEl?.innerText || '');
  const readMins = words === 0 ? 0 : Math.max(1, Math.ceil(words / 200));
  setStatsText(`${words} words • ${chars} chars • ${readMins} min read`);
};

export const exec = (cmd: string, value?: string) => {
  editorEl?.focus();
  document.execCommand(cmd, false, value);
  refreshStats();
};

// ── Keyboard shortcut dispatcher
export function installKeyboardShortcuts(
  saveDoc: () => void,
) {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && focusMode()) {
      setFocusMode(false);
      setSaveStateText('Focus mode disabled');
      return;
    }
    if (!e.ctrlKey && !e.metaKey) return;
    const key = e.key.toLowerCase();
    if (key === 's') { e.preventDefault(); saveDoc(); }
    else if (key === 'b') { e.preventDefault(); exec('bold'); }
    else if (key === 'i') { e.preventDefault(); exec('italic'); }
    else if (key === 'u') { e.preventDefault(); exec('underline'); }
    else if (key === 'o') { e.preventDefault(); fileInputEl.value = ''; fileInputEl.click(); }
    else if (key === 'n') {
      e.preventDefault();
      editorEl.innerHTML = '<p></p>';
      docTitleEl.value = DEFAULT_TITLE;
      refreshStats();
      setSaveStateText('Unsaved new document');
      editorEl.focus();
    }
  });
}
