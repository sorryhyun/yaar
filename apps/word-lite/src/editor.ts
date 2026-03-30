import { countTextStats, DEFAULT_TITLE } from './utils';
import { editorEl, focusMode, setFocusMode, setStatsText, setSaveStateText, fileInputEl, docTitleEl } from './state';
import { onShortcut } from '@bundled/yaar';

export const refreshStats = () => {
  const { words, chars } = countTextStats(editorEl?.innerText || '');
  const readMins = words === 0 ? 0 : Math.max(1, Math.ceil(words / 200));
  setStatsText(`${words} words \u2022 ${chars} chars \u2022 ${readMins} min read`);
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
  onShortcut('escape', () => {
    if (focusMode()) {
      setFocusMode(false);
      setSaveStateText('Focus mode disabled');
    }
  });
  onShortcut('ctrl+s', () => saveDoc());
  onShortcut('ctrl+b', () => exec('bold'));
  onShortcut('ctrl+i', () => exec('italic'));
  onShortcut('ctrl+u', () => exec('underline'));
  onShortcut('ctrl+o', () => { fileInputEl.value = ''; fileInputEl.click(); });
  onShortcut('ctrl+n', () => {
    editorEl.innerHTML = '<p></p>';
    docTitleEl.value = DEFAULT_TITLE;
    refreshStats();
    setSaveStateText('Unsaved new document');
    editorEl.focus();
  });
}
