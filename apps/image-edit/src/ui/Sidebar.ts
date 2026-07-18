import { For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { DEFAULT_FILTERS, outputSize } from '../core/doc';
import {
  brushSize,
  clearSelection,
  contiguous,
  dispatch,
  doc,
  drawColor,
  drawSize,
  eraser,
  hasSelection,
  openStoragePath,
  refreshStorageFiles,
  selectAll,
  selectMode,
  setBrushSize,
  setContiguous,
  setDrawColor,
  setDrawSize,
  setEraser,
  setSelectMode,
  setTolerance,
  storageFiles,
  tolerance,
  type StorageFile,
} from '../store';
import { cropToSelection, hasDoc, removeFile, removeSelection, setFilter } from './actions';
import { FILTER_CONTROLS, SELECT_MODES } from './constants';

// Library thumbnails deliberately omit loading="lazy": inside the app iframe
// the intersection check never fires, so lazy images stay blank forever.
// Note also that HTML comments inside an `html` template misalign the
// expression indices — keep notes like this one outside the template.

// Icon-only, mirroring the toolbar's transform group. Unicode characters
// directly, not HTML entities: Solid sets interpolated strings as textContent,
// so `&#9906;` would render as literal text.
const SELECTION_ACTIONS: Array<{
  icon: string;
  label: string;
  title: string;
  enabled: () => boolean;
  run: () => void;
}> = [
  {
    icon: '⛶',
    label: 'Crop to selection',
    title: "Crop to the selection's bounds and make everything outside it transparent",
    enabled: hasSelection,
    run: cropToSelection,
  },
  {
    icon: '⌦',
    label: 'Remove selection',
    title: 'Remove selection — exports transparent as PNG',
    enabled: hasSelection,
    run: removeSelection,
  },
  {
    icon: '◨',
    label: 'Invert selection',
    title: 'Invert selection',
    enabled: hasDoc,
    run: () => dispatch({ type: 'invertSelection' }),
  },
  {
    icon: '▣',
    label: 'Select all',
    title: 'Select all',
    enabled: hasDoc,
    run: () => selectAll(),
  },
  {
    icon: '⊘',
    label: 'Clear selection',
    title: 'Clear selection',
    enabled: hasSelection,
    run: () => clearSelection(),
  },
  {
    icon: '↺',
    label: 'Restore removed',
    title: 'Restore removed pixels',
    enabled: () => !!doc()?.removed,
    run: () => dispatch({ type: 'restoreRemoved' }),
  },
];

export function Sidebar() {
  return html`
    <aside class="sidebar y-scroll">
      <div class="section">
        <div class="y-label">Selection</div>

        <div class="control">
          <div class="control-head">
            <span>Tolerance</span>
            <span class="y-text-muted">${() => tolerance()}</span>
          </div>
          <input
            type="range"
            min="0"
            max="128"
            step="1"
            disabled=${() => !hasDoc()}
            value=${() => tolerance()}
            oninput=${(e: Event) => setTolerance(Number((e.target as HTMLInputElement).value))}
          />
        </div>

        <div class="seg">
          <button
            class=${() => `y-btn y-btn-sm ${contiguous() ? 'y-btn-primary' : ''}`}
            onClick=${() => setContiguous(true)}
          >
            Contiguous
          </button>
          <button
            class=${() => `y-btn y-btn-sm ${!contiguous() ? 'y-btn-primary' : ''}`}
            onClick=${() => setContiguous(false)}
          >
            Global
          </button>
        </div>

        <div class="seg">
          <${For} each=${SELECT_MODES}>
            ${(m: (typeof SELECT_MODES)[number]) => html`
              <button
                class=${() => `y-btn y-btn-sm ${selectMode() === m.id ? 'y-btn-primary' : ''}`}
                onClick=${() => setSelectMode(m.id)}
              >
                ${m.label}
              </button>
            `}
          <//>
        </div>

        <div class="control">
          <div class="control-head">
            <span>Lasso brush</span>
            <span class="y-text-muted">${() => brushSize()}px</span>
          </div>
          <input
            type="range"
            min="2"
            max="120"
            step="1"
            disabled=${() => !hasDoc()}
            value=${() => brushSize()}
            oninput=${(e: Event) => setBrushSize(Number((e.target as HTMLInputElement).value))}
          />
        </div>

        <div class="icon-grid" role="group" aria-label="Selection actions">
          <${For} each=${SELECTION_ACTIONS}>
            ${(a: (typeof SELECTION_ACTIONS)[number]) => html`
              <button
                class="y-btn y-btn-sm icon-btn"
                title=${a.title}
                aria-label=${a.label}
                disabled=${() => !a.enabled()}
                onClick=${() => a.run()}
              >
                ${a.icon}
              </button>
            `}
          <//>
        </div>

        <div class="y-text-xs y-text-muted">
          Wand clicks a colour; Lasso drags a free shape. Remove exports transparent as PNG.
        </div>
      </div>

      <div class="section">
        <div class="y-label">Draw</div>
        <div class="draw-row">
          <input
            type="color"
            class="color-input"
            disabled=${() => !hasDoc()}
            value=${() => drawColor()}
            oninput=${(e: Event) => setDrawColor((e.target as HTMLInputElement).value)}
          />
          <button
            class=${() => `y-btn y-btn-sm ${eraser() ? 'y-btn-primary' : ''}`}
            disabled=${() => !hasDoc()}
            onClick=${() => setEraser(!eraser())}
          >
            Eraser
          </button>
        </div>
        <div class="control">
          <div class="control-head">
            <span>Brush size</span>
            <span class="y-text-muted">${() => drawSize()}px</span>
          </div>
          <input
            type="range"
            min="1"
            max="120"
            step="1"
            disabled=${() => !hasDoc()}
            value=${() => drawSize()}
            oninput=${(e: Event) => setDrawSize(Number((e.target as HTMLInputElement).value))}
          />
        </div>
        <button
          class="y-btn y-btn-sm y-btn-ghost"
          disabled=${() => !doc()?.strokes.length}
          onClick=${() => dispatch({ type: 'clearStrokes' })}
        >
          Clear drawing
        </button>
      </div>

      <div class="section">
        <div class="library-head">
          <span class="y-label">Library</span>
          <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => refreshStorageFiles()}>
            Refresh
          </button>
        </div>
        <${Show}
          when=${() => storageFiles().length > 0}
          fallback=${() =>
            html`<div class="y-text-xs y-text-muted">
              No saved images yet. Use “Save to storage”.
            </div>`}
        >
          <div class="library-grid">
            <${For} each=${storageFiles}>
              ${(file: StorageFile) => html`
                <div class="lib-item">
                  <button
                    class="lib-thumb"
                    title=${file.name}
                    onClick=${() => openStoragePath(file.path)}
                  >
                    <img src=${file.url} alt=${file.name} />
                    <span class="y-truncate lib-name">${file.name}</span>
                  </button>
                  <button class="lib-del" title="Delete" onClick=${() => removeFile(file)}>
                    ×
                  </button>
                </div>
              `}
            <//>
          </div>
        <//>
      </div>

      <div class="section section-tight">
        <div class="y-label">Filters</div>
        <${For} each=${FILTER_CONTROLS}>
          ${(control: (typeof FILTER_CONTROLS)[number]) => html`
            <div class="filter-row">
              <span class="filter-label y-truncate" title=${control.label}>${control.label}</span>
              <input
                type="range"
                aria-label=${control.label}
                min=${control.min}
                max=${control.max}
                step=${control.step}
                disabled=${() => !hasDoc()}
                value=${() => doc()?.filters[control.key] ?? DEFAULT_FILTERS[control.key]}
                oninput=${(e: Event) =>
                  setFilter(control.key, Number((e.target as HTMLInputElement).value))}
              />
              <span class="filter-value"
                >${() =>
                  (doc()?.filters[control.key] ?? DEFAULT_FILTERS[control.key]).toString()}</span
              >
            </div>
          `}
        <//>
        <button
          class="y-btn y-btn-sm y-btn-ghost"
          disabled=${() => !hasDoc()}
          onClick=${() => dispatch({ type: 'resetFilters' })}
        >
          Reset filters
        </button>
      </div>

      <div class="section">
        <div class="y-label">Size</div>
        <div class="size-row">
          <input
            class="y-input"
            type="number"
            min="1"
            disabled=${() => !hasDoc()}
            value=${() => (doc() ? outputSize(doc()!).w : '')}
            onchange=${(e: Event) => {
              const w = Number((e.target as HTMLInputElement).value);
              if (w > 0) dispatch({ type: 'resize', width: w });
            }}
          />
          <span class="y-text-muted">×</span>
          <input
            class="y-input"
            type="number"
            min="1"
            disabled=${() => !hasDoc()}
            value=${() => (doc() ? outputSize(doc()!).h : '')}
            onchange=${(e: Event) => {
              const h = Number((e.target as HTMLInputElement).value);
              if (h > 0) dispatch({ type: 'resize', height: h });
            }}
          />
        </div>
        <div class="y-text-xs y-text-muted">Editing one dimension keeps the aspect ratio.</div>
      </div>
    </aside>
  `;
}
