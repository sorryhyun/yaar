import { For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import {
  canRedo,
  canUndo,
  dispatch,
  doc,
  openLocalFile,
  redoEdit,
  setTool,
  undoEdit,
} from '../store';
import { activeTool, doExport, doSaveToStorage, hasDoc } from './actions';
import { HISTORY_ICONS, TOOLS, TRANSFORMS } from './constants';
import { openLibrary } from './LibraryModal';

export function Toolbar() {
  return html`
    <div class="toolbar y-toolbar">
      <div class="tb-group">
        <label class="y-btn y-btn-sm file-btn" title="Open an image file">
          <span>Open</span>
          <input
            type="file"
            accept="image/*"
            onchange=${(e: Event) => {
              const file = (e.target as HTMLInputElement).files?.[0];
              if (file) openLocalFile(file);
            }}
          />
        </label>
        <button
          class="y-btn y-btn-sm"
          title="Save a PNG into app storage"
          disabled=${() => !hasDoc()}
          onClick=${doSaveToStorage}
        >
          Save
        </button>
      </div>

      <span class="sep"></span>

      <div class="tb-group tb-seg" role="group" aria-label="Tools">
        <${For} each=${TOOLS}>
          ${(t: (typeof TOOLS)[number]) => html`
            <button
              class=${() => `tb-seg-btn ${activeTool(t.id) ? 'is-active' : ''}`}
              title=${t.title}
              aria-pressed=${() => (activeTool(t.id) ? 'true' : 'false')}
              disabled=${() => !hasDoc()}
              onClick=${() => setTool(activeTool(t.id) ? 'none' : t.id)}
            >
              ${t.label}
            </button>
          `}
        <//>
      </div>

      <span class="sep"></span>

      <div class="tb-group" role="group" aria-label="Transform">
        <${For} each=${TRANSFORMS}>
          ${(t: (typeof TRANSFORMS)[number]) => html`
            <button
              class="y-btn y-btn-sm tb-icon"
              title=${t.title}
              aria-label=${t.title}
              disabled=${() => !hasDoc()}
              onClick=${() => dispatch(t.cmd)}
            >
              ${t.icon}
            </button>
          `}
        <//>
        <button
          class="y-btn y-btn-sm tb-icon"
          title="Uncrop — restore the full image area"
          aria-label="Uncrop"
          disabled=${() => !doc()?.crop}
          onClick=${() => dispatch({ type: 'uncrop' })}
        >
          ⤡
        </button>
      </div>

      <span class="sep"></span>

      <div class="tb-group" role="group" aria-label="History">
        <button
          class="y-btn y-btn-sm tb-icon"
          title="Undo"
          aria-label="Undo"
          disabled=${() => !canUndo()}
          onClick=${() => undoEdit()}
        >
          ${HISTORY_ICONS.undo}
        </button>
        <button
          class="y-btn y-btn-sm tb-icon"
          title="Redo"
          aria-label="Redo"
          disabled=${() => !canRedo()}
          onClick=${() => redoEdit()}
        >
          ${HISTORY_ICONS.redo}
        </button>
      </div>

      <span class="spacer"></span>

      <div class="tb-group">
        <button
          class="y-btn y-btn-sm y-btn-danger"
          title="Discard every edit and start over"
          disabled=${() => !hasDoc()}
          onClick=${() => dispatch({ type: 'reset' })}
        >
          Reset
        </button>
        <button
          class="y-btn y-btn-sm"
          title="Browse images saved in app storage"
          onClick=${() => openLibrary()}
        >
          Library
        </button>
        <div class="tb-split">
          <button
            class="y-btn y-btn-sm y-btn-primary"
            title="Export a PNG — keeps transparency"
            disabled=${() => !hasDoc()}
            onClick=${() => doExport('png')}
          >
            Export PNG
          </button>
          <button
            class="y-btn y-btn-sm"
            title="Export a JPEG — no transparency, flattened onto white"
            disabled=${() => !hasDoc()}
            onClick=${() => doExport('jpeg')}
          >
            JPEG
          </button>
        </div>
      </div>
    </div>
  `;
}
