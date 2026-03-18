export {};
import { createSignal, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { createPatch } from '@bundled/diff';
import { html as diff2Html } from '@bundled/diff2html';
import 'diff2html/bundles/css/diff2html.min.css';

// ── State ──

const [oldText, setOldText] = createSignal('');
const [newText, setNewText] = createSignal('');
const [diffHtml, setDiffHtml] = createSignal('');
const [viewMode, setViewMode] = createSignal<'side-by-side' | 'unified'>('unified');
const [fileName, setFileName] = createSignal('file.ts');

export function showDiff(oldContent: string, newContent: string, name?: string) {
  setOldText(oldContent);
  setNewText(newContent);
  if (name) setFileName(name);
  runDiff(oldContent, newContent, name ?? fileName());
}

export function clearDiff() {
  setOldText('');
  setNewText('');
  setDiffHtml('');
}

export const hasDiff = () => diffHtml().length > 0;

function runDiff(old: string, cur: string, name: string) {
  if (!old && !cur) {
    setDiffHtml('');
    return;
  }
  const patch = createPatch(name, old, cur, '', '', { context: 3 });
  const rendered = diff2Html(patch, {
    drawFileList: false,
    outputFormat: viewMode() === 'side-by-side' ? 'side-by-side' : 'line-by-line',
    matching: 'lines',
    colorScheme: 'dark' as never,
  });
  setDiffHtml(rendered);
}

// ── Component ──

export function DiffPanel() {
  function updateDiff() {
    runDiff(oldText(), newText(), fileName());
  }

  return html`
    <div class="diff-panel">
      <${Show}
        when=${() => diffHtml()}
        fallback=${html`
          <div class="diff-input-area">
            <div class="diff-input-col">
              <label class="y-text-xs y-text-muted">Old</label>
              <textarea
                class="diff-textarea"
                placeholder="Paste original text..."
                value=${oldText}
                onInput=${(e: Event) => setOldText((e.target as HTMLTextAreaElement).value)}
              ></textarea>
            </div>
            <div class="diff-input-col">
              <label class="y-text-xs y-text-muted">New</label>
              <textarea
                class="diff-textarea"
                placeholder="Paste modified text..."
                value=${newText}
                onInput=${(e: Event) => setNewText((e.target as HTMLTextAreaElement).value)}
              ></textarea>
            </div>
            <div class="diff-actions">
              <button
                class="y-btn y-btn-sm y-btn-primary"
                disabled=${() => !oldText() && !newText()}
                onClick=${updateDiff}
              >
                Compare
              </button>
            </div>
          </div>
        `}
      >
        <div class="diff-toolbar">
          <select
            class="y-select y-select-sm"
            value=${viewMode}
            onChange=${(e: Event) => {
              setViewMode((e.target as HTMLSelectElement).value as 'side-by-side' | 'unified');
              updateDiff();
            }}
          >
            <option value="unified">Unified</option>
            <option value="side-by-side">Side by Side</option>
          </select>
          <button class="y-btn y-btn-sm" onClick=${() => clearDiff()}>
            New Diff
          </button>
        </div>
        <div class="diff-output" innerHTML=${diffHtml}></div>
      <//>
    </div>
  `;
}
