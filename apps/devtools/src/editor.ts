export {};
import { createSignal, createEffect, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import Prism from '@bundled/prismjs';
import { openFilePath, openFileContent, writeFile } from './project';

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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const [isDirty, setIsDirty] = createSignal(false);
const [localContent, setLocalContent] = createSignal<string>('');
const [highlightedHtml, setHighlightedHtml] = createSignal('');
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function currentContent(): string {
  const content = openFileContent() ?? '';
  if (!isDirty()) setLocalContent(content);
  return isDirty() ? localContent() : content;
}

// Re-highlight when content or file changes
createEffect(() => {
  const code = currentContent();
  const lang = getLanguage(openFilePath());
  setHighlightedHtml(highlight(code, lang));
});

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

function syncScroll(e: Event) {
  const ta = e.target as HTMLTextAreaElement;
  const pre = ta.parentElement?.querySelector('.editor-highlight') as HTMLElement | null;
  if (pre) {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
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
          <div class="editor-overlay">
            <pre
              class="editor-highlight"
              aria-hidden="true"
            ><code innerHTML=${highlightedHtml}></code>
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
                  const lang = getLanguage(openFilePath());
                  setHighlightedHtml(highlight(ta.value, lang));
                  scheduleSave();
                }
              }}
            ></textarea>
          </div>
        </div>
      <//>
    </div>
  `;
}
