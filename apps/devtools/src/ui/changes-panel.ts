export {};
import { createMemo, createSignal, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { html as diff2Html } from '@bundled/diff2html';
import { formatClock } from '@bundled/yaar';
import 'diff2html/bundles/css/diff2html.min.css';
import { fileChanges, type FileChange } from '../core';
import { clearChanges, currentChange } from '../services';
import { buildPatch, truncatePatch } from '../lib';
import { changesMode, diffViewMode, setChangesMode, setDiffViewMode, setMainView } from './panel-state';

// The Changes view: every write, edit, copy and delete the IDE performs, with the
// actual diff. It replaces a one-line status message ("Saved src/foo.ts") that said
// something happened without ever saying what.
//
// It fills the editor area rather than the bottom panel. A diff is read the way a
// file is read — wide, and for minutes — so it takes the pane sized for that, and
// the bottom panel goes back to being the short one for Problems and Console. The
// list of changed files is a tab of the sidebar; this file holds only the diff.

/**
 * How much of a patch renders before the reader has to ask for the rest.
 *
 * A whole-file create can run to thousands of lines; drawing it eagerly stalls the
 * view and buries every other entry. The head of a diff is the part that gets
 * read, so the cap keeps that and puts the tail behind a button.
 */
const MAX_PATCH_LINES = 400;

/** Which change the reader asked to see whole. An id, so a new selection re-caps. */
const [showFullId, setShowFullId] = createSignal<string | null>(null);

// ── Manual compare (paste two texts) ──

const [oldText, setOldText] = createSignal('');
const [newText, setNewText] = createSignal('');
const [manualHtml, setManualHtml] = createSignal('');

function renderPatch(patch: string): string {
  return diff2Html(patch, {
    drawFileList: false,
    outputFormat: diffViewMode() === 'side-by-side' ? 'side-by-side' : 'line-by-line',
    matching: 'lines',
    colorScheme: 'dark' as never,
  });
}

/**
 * Show an arbitrary before/after pair, outside the recorded history. The view's
 * only entry point for a diff no file operation produced.
 */
export function showDiff(oldContent: string, newContent: string, name = 'file.ts'): void {
  setOldText(oldContent);
  setNewText(newContent);
  setChangesMode('manual');
  setMainView('changes');
  setManualHtml(renderPatch(buildPatch(name, oldContent, newContent)));
}

export const hasChanges = () => fileChanges().length > 0;

const KIND_LABEL: Record<FileChange['kind'], string> = {
  create: 'created',
  update: 'modified',
  delete: 'deleted',
};

// ── Derived diff for the selected change ──

/**
 * The patch for the change on screen, already capped.
 *
 * A memo because it re-runs on selection, view mode and "show full" — diffing a
 * large file on every unrelated signal read is the one expensive thing this view
 * does.
 */
const patchView = createMemo(() => {
  const change = currentChange();
  if (!change) return null;
  const patch = buildPatch(change.path, change.before, change.after);
  const capped =
    showFullId() === change.id
      ? { patch, truncated: false, totalLines: patch.split('\n').length }
      : truncatePatch(patch, MAX_PATCH_LINES);
  return { change, ...capped };
});

const changeHtml = createMemo(() => {
  const view = patchView();
  return view ? renderPatch(view.patch) : '';
});

// ── Components ──

function ChangeDetail() {
  return html`
    <div class="changes-detail">
      <${Show}
        when=${patchView}
        fallback=${html`
          <div class="diagnostics-empty y-text-xs y-text-muted">
            Write or edit a file and its diff appears here.
          </div>
        `}
      >
        <div class="change-head">
          <span class="change-head-path y-text-xs y-font-mono y-truncate"
            >${() => patchView()?.change.path ?? ''}</span
          >
          <span class="y-badge y-text-xs"
            >${() => KIND_LABEL[patchView()?.change.kind ?? 'update']}</span
          >
          <span class="y-text-xs y-text-dim">${() => patchView()?.change.label ?? ''}</span>
          <span class="change-added y-text-xs">+${() => patchView()?.change.added ?? 0}</span>
          <span class="change-removed y-text-xs">-${() => patchView()?.change.removed ?? 0}</span>
          <span class="y-text-xs y-text-dim"
            >${() => formatClock(patchView()?.change.timestamp ?? Date.now())}</span
          >
        </div>
        <div class="diff-output" innerHTML=${changeHtml}></div>
        <${Show} when=${() => patchView()?.truncated}>
          <div class="diff-more">
            <button
              class="y-btn y-btn-sm"
              onClick=${() => setShowFullId(patchView()?.change.id ?? null)}
            >
              Show more — ${() => patchView()?.totalLines ?? 0} diff lines total
            </button>
          </div>
        <//>
      <//>
    </div>
  `;
}

function ManualCompare() {
  return html`
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
          onClick=${() =>
            setManualHtml(renderPatch(buildPatch('comparison', oldText(), newText())))}
        >
          Compare
        </button>
      </div>
      <div class="diff-output diff-manual-output" innerHTML=${manualHtml}></div>
    </div>
  `;
}

/** The diff pane. Rendered by Workspace in place of the editor. */
export function ChangeView() {
  return html`
    <div class="change-view">
      <div class="changes-toolbar">
        <span class="y-text-xs y-text-muted">Changes</span>
        <select
          class="y-select y-text-xs"
          value=${diffViewMode}
          onChange=${(e: Event) =>
            setDiffViewMode((e.target as HTMLSelectElement).value as 'side-by-side' | 'unified')}
        >
          <option value="unified">Unified</option>
          <option value="side-by-side">Side by side</option>
        </select>
        <button
          class="y-btn y-btn-sm y-btn-ghost"
          onClick=${() => setChangesMode(changesMode() === 'manual' ? 'changes' : 'manual')}
        >
          ${() => (changesMode() === 'manual' ? 'Back to changes' : 'Compare text…')}
        </button>
        <span class="changes-toolbar-gap"></span>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => clearChanges()}>Clear</button>
        <button
          class="y-btn y-btn-sm y-btn-ghost"
          title="Back to the editor"
          onClick=${() => setMainView('editor')}
        >
          ✕ Close
        </button>
      </div>
      <${Show} when=${() => changesMode() === 'changes'} fallback=${html`<${ManualCompare} />`}>
        <${ChangeDetail} />
      <//>
    </div>
  `;
}
