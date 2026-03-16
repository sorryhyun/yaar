import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { statsText, saveStateText, focusMode, setEditorEl, setDocTitleEl, setFileInputEl, setFormatBlockEl, editorEl } from './state';
import { exec, refreshStats, installKeyboardShortcuts } from './editor';
import { saveDoc, autoSave, loadDoc } from './documents';
import {
  handleEditorInput,
  handleLink,
  handleNew,
  handleOpen,
  handleFocus,
  handleExportTxt,
  handleExportHtml,
  handleExportDocx,
  handleExportMd,
  handleFileChange,
  handleEditorClick,
} from './handlers';
import { registerAppProtocol } from './protocol';

// ── Mount
render(() => html`
  <div class=${() => 'app-shell y-light' + (focusMode() ? ' focus-mode' : '')}>
    <div class="topbar">
      <div class="brand"><span class="brand-badge">W</span> Word Lite</div>
      <div class="doc-meta">
        <label for="doc-title" class="muted">Title</label>
        <input
          id="doc-title"
          class="y-input doc-title-input"
          type="text"
          placeholder="Untitled Document"
          maxlength="100"
          ref=${(el: HTMLInputElement) => { setDocTitleEl(el); }}
          onInput=${() => { autoSave(); }}
        />
      </div>
    </div>

    <div class="toolbar">
      <div class="group">
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('bold')}><b>B</b></button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('italic')}><i>I</i></button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('underline')}><u>U</u></button>
      </div>
      <div class="group">
        <select
          class="y-input"
          title="Style"
          ref=${(el: HTMLSelectElement) => { setFormatBlockEl(el); }}
          onChange=${(e: Event) => exec('formatBlock', (e.target as HTMLSelectElement).value)}
        >
          <option value="P">Paragraph</option>
          <option value="H1">Heading 1</option>
          <option value="H2">Heading 2</option>
          <option value="H3">Heading 3</option>
          <option value="BLOCKQUOTE">Quote</option>
        </select>
      </div>
      <div class="group">
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('justifyLeft')}>Left</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('justifyCenter')}>Center</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('justifyRight')}>Right</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('insertUnorderedList')}>• List</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('insertOrderedList')}>1. List</button>
      </div>
      <div class="group">
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${handleLink}>Link</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('removeFormat')}>Clear</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('undo')}>Undo</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => exec('redo')}>Redo</button>
      </div>
      <div class="group">
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${handleNew}>New</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${handleOpen}>Open</button>
        <button class="y-btn y-btn-sm y-btn-primary" onClick=${saveDoc}>Save</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${handleExportTxt}>.txt</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${handleExportHtml}>.html</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${handleExportDocx}>.docx</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${handleExportMd}>.md</button>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${handleFocus}>Focus</button>
      </div>
    </div>

    <div class="editor-wrap">
      <article
        class="page"
        contenteditable="true"
        spellcheck="true"
        data-placeholder="Start typing..."
        ref=${(el: HTMLElement) => { setEditorEl(el); }}
        onInput=${handleEditorInput}
        onKeyup=${refreshStats}
        onClick=${handleEditorClick}
      ></article>
      <input
        type="file"
        accept=".txt,.html,.htm,.docx,.md"
        style="display:none"
        ref=${(el: HTMLInputElement) => { setFileInputEl(el); }}
        onChange=${handleFileChange}
      />
    </div>

    <div class="statusbar y-text-sm">
      <span>${() => statsText()}</span>
      <span>${() => saveStateText()}</span>
    </div>
  </div>
`, document.getElementById('app')!);

// ref fires synchronously during mount — all elements are ready
loadDoc().then(() => editorEl.focus());

// ── App Protocol
registerAppProtocol();
