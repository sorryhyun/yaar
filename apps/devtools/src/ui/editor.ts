export {};
import { createSignal, createEffect, onCleanup, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { debounce } from '@bundled/lodash';
import Prism from '@bundled/prismjs';
import { createPersistedSignal, errMsg, escapeHtml } from '@bundled/yaar';
import { openFilePath, openFileContent, openFileImage, setStatusText } from '../core';
import { writeFile } from '../services';

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
const [highlightedHtml, setHighlightedHtml] = createSignal('');
const [showLineNumbers, setShowLineNumbers] = createPersistedSignal(
  'preferences/show-line-numbers.json',
  true,
  { label: 'editor preferences' },
);
const [editorScrollTop, setEditorScrollTop] = createSignal(0);
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
  const path = openFilePath();
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
          <span class="editor-file-name">${() => openFilePath()}</span>
          <${Show} when=${isDirty}>
            <span class="y-dot y-dot-accent"></span>
          <//>
          <${Show} when=${() => !openFileImage()}>
            <button
              class="editor-line-number-toggle y-btn y-btn-ghost y-btn-sm"
              type="button"
              aria-pressed=${showLineNumbers}
              title="Toggle line numbers"
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

/** The code surface: highlighted <pre> under a transparent <textarea>. */
function TextEditor() {
  return html`
    <div class="editor-content">
      <${Show} when=${showLineNumbers}>
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
          class="editor-textarea"
          spellcheck=${false}
          value=${currentContent}
          onInput=${(e: Event) => {
            const val = (e.target as HTMLTextAreaElement).value;
            setLocalContent(val);
            setIsDirty(true);
            const lang = getLanguage(openFilePath());
            setHighlightedHtml(highlight(val, lang));
            scheduleSave();
          }}
          onScroll=${syncScroll}
          onKeyDown=${(e: KeyboardEvent) => {
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
              setIsDirty(true);
              const lang = getLanguage(openFilePath());
              setHighlightedHtml(highlight(ta.value, lang));
              scheduleSave();
            }
          }}
        ></textarea>
      </div>
    </div>
  `;
}
