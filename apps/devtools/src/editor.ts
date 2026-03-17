export {};
import { createEffect, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import Prism from '@bundled/prismjs';
import { openFilePath, openFileContent } from './project';

function getLanguage(path: string): string {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.js') || path.endsWith('.jsx')) return 'javascript';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.json')) return 'javascript';
  if (path.endsWith('.md')) return 'markdown';
  return 'plaintext';
}

export function Editor() {
  let codeEl: HTMLElement | undefined;

  createEffect(() => {
    const content = openFileContent();
    const path = openFilePath();
    if (codeEl && content !== null && path) {
      const lang = getLanguage(path);
      const grammar = Prism.languages[lang] ?? Prism.languages['plaintext'];
      if (grammar) {
        codeEl.innerHTML = Prism.highlight(content, grammar, lang);
      } else {
        codeEl.textContent = content;
      }
    }
  });

  return html`
    <div class="editor">
      <${Show}
        when=${() => openFilePath()}
        fallback=${html`
          <div class="editor-empty y-text-sm y-text-muted">Select a file to view</div>
        `}
      >
        <div class="editor-header y-text-xs y-text-muted">${() => openFilePath()}</div>
        <div class="editor-content y-scroll">
          <pre class="editor-pre"><code ref=${(el: HTMLElement) => {
            codeEl = el;
          }}></code></pre>
        </div>
      <//>
    </div>
  `;
}
