export {};
import { createSignal, createEffect, on, onCleanup, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { debounce } from '@bundled/lodash';
import Prism from '@bundled/prismjs';
import { createPersistedSignal, errMsg, escapeHtml } from '@bundled/yaar';
import { openFilePath, openFileContent, openFileImage, setStatusText } from '../core';
import { writeFile } from '../services';
import { pendingReveal, setPendingReveal } from './panel-state';
import {
  ReferencesPopover,
  hideReferences,
  onEditorMouseLeave,
  onEditorMouseMove,
} from './references-hover';

// Register TypeScript grammar (Prism base only has js/css/markup)
// TypeScript extends JavaScript, so we define it here
if (!Prism.languages.typescript) {
  Prism.languages.typescript = Prism.languages.extend('javascript', {
    'class-name': {
      pattern:
        /(\b(?:class|extends|implements|instanceof|interface|new|type)\s+)(?!keyof\b)(?!\s)[_$a-zA-Z\xA0-\uFFFF](?:(?!\s)[$\w\xA0-\uFFFF])*(?:\s*<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>)?/,
      lookbehind: true,
      greedy: true,
      inside: null as any,
    },
    builtin:
      /\b(?:Array|Function|Promise|any|boolean|console|never|number|string|symbol|unknown|void)\b/,
    keyword:
      /\b(?:abstract|as|asserts|async|await|break|case|catch|class|const|constructor|continue|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|is|keyof|let|module|namespace|new|null|of|package|private|protected|public|readonly|return|require|set|static|super|switch|this|throw|try|type|typeof|undefined|var|while|with|yield)\b/,
    operator:
      /--|\+\+|\*\*=?|=>|&&=?|\|\|=?|[!=]==|<<=?|>>>?=?|[-+*/%&|^!=<>]=?|\.{3}|\?\?=?|\?\.?|[~:]/,
  });
  Prism.languages.ts = Prism.languages.typescript;
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  css: 'css',
  html: 'markup',
  json: 'javascript',
};

function getLanguage(filePath: string | null): string {
  if (!filePath) return 'clike';
  const ext = filePath.split('.').pop() ?? '';
  return EXT_LANG[ext] ?? 'clike';
}

function highlight(code: string, lang: string): string {
  const grammar = (Prism.languages as Record<string, any>)[lang] ?? Prism.languages.clike;
  if (!grammar) return escapeHtml(code);
  try {
    return Prism.highlight(code, grammar, lang);
  } catch {
    return escapeHtml(code);
  }
}

const [isDirty, setIsDirty] = createSignal(false);
const [localContent, setLocalContent] = createSignal<string>('');
/**
 * The file the unsaved buffer was typed into. The open file can change under a pending
 * autosave — a click in the tree, or the agent opening a file from another copy of this
 * window — and the save has to land where the text came from, not on whatever is open
 * by the time the timer fires.
 */
let bufferPath: string | null = null;
const [highlightedHtml, setHighlightedHtml] = createSignal('');
const [showLineNumbers, setShowLineNumbers] = createPersistedSignal(
  'preferences/show-line-numbers.json',
  true,
  { label: 'editor preferences' },
);
const [wordWrap, setWordWrap] = createPersistedSignal('preferences/word-wrap.json', false, {
  label: 'editor preferences',
});
const [editorScrollTop, setEditorScrollTop] = createSignal(0);

/** 1-based caret position in the open file, or null before the textarea is touched. */
export const [cursorPos, setCursorPos] = createSignal<{ line: number; col: number } | null>(null);

function trackCursor(e: Event) {
  const ta = e.target as HTMLTextAreaElement;
  const before = ta.value.slice(0, ta.selectionStart);
  const lineStart = before.lastIndexOf('\n') + 1;
  setCursorPos({ line: before.split('\n').length, col: ta.selectionStart - lineStart + 1 });
}

createEffect(() => {
  openFilePath();
  setCursorPos(null);
});
const SAVE_DELAY_MS = 1000;

function currentContent(): string {
  const content = openFileContent() ?? '';
  if (!isDirty()) setLocalContent(content);
  return isDirty() ? localContent() : content;
}

createEffect(() => {
  const code = currentContent();
  const lang = getLanguage(openFilePath());
  setHighlightedHtml(highlight(code, lang));
});

// The actual write. Guarded by the dirty flag, so it is a no-op when there is
// nothing pending — which makes it safe to call after a flush().
function performSave() {
  const path = bufferPath;
  if (path && isDirty()) {
    // The write is fire-and-forget so typing never waits on storage, which makes a
    // rejection nobody catches the failure mode — an autosave that silently stopped
    // saving. Say so in the status bar instead.
    writeFile(path, localContent()).catch((err: unknown) => {
      setStatusText(`Could not save ${path}: ${errMsg(err)}`);
    });
    setIsDirty(false);
  }
}

const debouncedSave = debounce(performSave, SAVE_DELAY_MS);

// Each keystroke re-arms the timer; lodash does the clear/re-schedule internally.
function scheduleSave() {
  debouncedSave();
}

// Explicit save (Ctrl/Cmd+S): flush any pending autosave so the edit that armed
// the timer is written now rather than discarded. flush() is a no-op when no
// call is pending, so performSave() covers the "dirty but unscheduled" case
// without risking a double write (flush clears the dirty flag first).
function saveNow() {
  debouncedSave.flush();
  performSave();
}

// Switching files writes the pending edit out first, so the buffer that was being
// typed does not stay on screen over the newly opened file until the timer fires.
createEffect(
  on(openFilePath, (path) => {
    if (isDirty() && bufferPath !== path) saveNow();
  }),
);

function lineNumbers(): string {
  const total = Math.max(1, currentContent().split('\n').length);
  const width = String(total).length;
  return Array.from({ length: total }, (_, i) => String(i + 1).padStart(width, ' ')).join('\n');
}

function syncScroll(e: Event) {
  const ta = e.target as HTMLTextAreaElement;
  const pre = ta.parentElement?.querySelector('.editor-highlight') as HTMLElement | null;
  if (pre) {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  }
  setEditorScrollTop(ta.scrollTop);
}

export function Editor() {
  // Teardown: write out any pending edit, then guarantee no timer outlives the
  // component. flush() already clears the pending call; cancel() is defensive.
  onCleanup(() => {
    debouncedSave.flush();
    debouncedSave.cancel();
  });

  return html`
    <div class="editor">
      <${Show}
        when=${() => openFilePath()}
        fallback=${html`
          <div class="editor-empty y-text-sm y-text-muted">Select a file to view</div>
        `}
      >
        <div class="y-editbar y-toolbar-dense editor-header y-text-muted">
          <span class="editor-file-name"
            ><span class="editor-file-dir"
              >${() => (openFilePath() ?? '').replace(/[^/]*$/, '')}</span
            ><span class="editor-file-base"
              >${() => (openFilePath() ?? '').split('/').pop()}</span
            ></span
          >
          <${Show} when=${isDirty}>
            <span class="y-dot y-dot-accent"></span>
          <//>
          <${Show} when=${() => !openFileImage()}>
            <button
              class="editor-toggle editor-wrap-toggle y-btn y-btn-ghost y-btn-sm"
              type="button"
              aria-pressed=${wordWrap}
              title="Toggle word wrap"
              onClick=${() => setWordWrap(!wordWrap())}
            >
              Wrap
            </button>
            <button
              class="editor-toggle y-btn y-btn-ghost y-btn-sm"
              type="button"
              aria-pressed=${() => showLineNumbers() && !wordWrap()}
              disabled=${wordWrap}
              title=${() =>
                wordWrap()
                  ? 'Line numbers are hidden while wrapping — the status bar shows the caret line'
                  : 'Toggle line numbers'}
              onClick=${() => setShowLineNumbers(!showLineNumbers())}
            >
              Lines
            </button>
          <//>
        </div>
        <${Show} when=${() => openFileImage()} fallback=${TextEditor}>
          <div class="editor-image">
            <img src=${() => openFileImage() ?? ''} alt=${() => openFilePath() ?? ''} />
          </div>
        <//>
      <//>
    </div>
  `;
}

/** Move the caret to a 1-based line/column and scroll it into the upper third of the view. */
function reveal(ta: HTMLTextAreaElement, line: number, column: number) {
  const lines = ta.value.split('\n');
  const row = Math.min(Math.max(line, 1), lines.length);
  let lineStart = 0;
  for (let i = 0; i < row - 1; i++) lineStart += lines[i].length + 1;
  const col = Math.min(Math.max(column - 1, 0), lines[row - 1].length);
  const offset = lineStart + col;
  ta.focus();
  ta.setSelectionRange(offset, offset);
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  ta.scrollTop = Math.max(0, (row - 1) * lineHeight - ta.clientHeight / 3);
  ta.dispatchEvent(new Event('scroll'));
  setCursorPos({ line: row, col: col + 1 });
}

/** The code surface: highlighted <pre> under a transparent <textarea>. */
function TextEditor() {
  let textarea: HTMLTextAreaElement | undefined;

  // Runs after the file's content lands in the textarea, whether the target file was
  // already open or had to be loaded first.
  createEffect(() => {
    const target = pendingReveal();
    const content = openFileContent();
    if (!target || !textarea || content == null || openFilePath() !== target.path) return;
    queueMicrotask(() => {
      if (textarea) reveal(textarea, target.line, target.column);
    });
    setPendingReveal(null);
  });

  return html`
    <div class=${() => `editor-content${wordWrap() ? ' wrap' : ''}`}>
      <${Show} when=${() => showLineNumbers() && !wordWrap()}>
        <div class="editor-gutter" aria-hidden="true">
          <pre
            class="editor-line-numbers"
            style=${() => `transform: translateY(-${editorScrollTop()}px)`}
          >
${lineNumbers}</pre
          >
        </div>
      <//>
      <div class="editor-overlay">
        <pre class="editor-highlight" aria-hidden="true"><code innerHTML=${highlightedHtml}></code>
</pre>
        <textarea
          ref=${(el: HTMLTextAreaElement) => (textarea = el)}
          class="editor-textarea"
          spellcheck=${false}
          value=${currentContent}
          onInput=${(e: Event) => {
            const val = (e.target as HTMLTextAreaElement).value;
            setLocalContent(val);
            bufferPath = openFilePath();
            setIsDirty(true);
            const lang = getLanguage(openFilePath());
            setHighlightedHtml(highlight(val, lang));
            scheduleSave();
            trackCursor(e);
            hideReferences();
          }}
          onScroll=${(e: Event) => {
            syncScroll(e);
            hideReferences();
          }}
          onMouseMove=${(e: MouseEvent) => onEditorMouseMove(e, isDirty())}
          onMouseLeave=${onEditorMouseLeave}
          onKeyUp=${trackCursor}
          onClick=${trackCursor}
          onFocus=${trackCursor}
          onKeyDown=${(e: KeyboardEvent) => {
            hideReferences();
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
              e.preventDefault();
              saveNow();
            }
            // Plain Tab only. Shift+Tab belongs to the shell (it opens the CLI panel),
            // and indenting on it made the editor eat the OS shortcut.
            if (e.key === 'Tab' && !e.shiftKey) {
              e.preventDefault();
              const ta = e.target as HTMLTextAreaElement;
              const start = ta.selectionStart;
              const end = ta.selectionEnd;
              const val = ta.value;
              ta.value = val.substring(0, start) + '  ' + val.substring(end);
              ta.selectionStart = ta.selectionEnd = start + 2;
              setLocalContent(ta.value);
              bufferPath = openFilePath();
              setIsDirty(true);
              const lang = getLanguage(openFilePath());
              setHighlightedHtml(highlight(ta.value, lang));
              scheduleSave();
            }
          }}
        ></textarea>
        <${ReferencesPopover} />
      </div>
    </div>
  `;
}
