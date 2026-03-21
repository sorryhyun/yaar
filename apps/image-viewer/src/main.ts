export {};
import { Show, For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import { app } from '@bundled/yaar';
import {
  images, selectedIds, mode, columns, status,
  setMode, setColumns, setStatus, setImages,
  loadAllStorageImages, loadLocalFiles, getShowItems, selectImage,
} from './store';
import { makeStatusText, clampColumns } from './helpers';
import { setupProtocol } from './protocol';
import type { ImageItem } from './types';

render(() => html`
  <div class="app y-app">
    <div class="toolbar y-flex y-gap-2 y-p-2 y-surface y-border-b">
      <input
        type="file"
        accept="image/*"
        multiple
        onchange=${(e: Event) => {
          const files = [...((e.target as HTMLInputElement).files || [])];
          if (files.length) loadLocalFiles(files);
        }}
      />
      <button class="y-btn y-btn-sm" onClick=${() => loadAllStorageImages()}>Load storage images</button>
      <button class="y-btn y-btn-sm" onClick=${() => { setMode('grid'); setStatus(makeStatusText(images().length, 'grid', columns())); }}>Grid</button>
      <button class="y-btn y-btn-sm" onClick=${() => { setMode('single'); setStatus(makeStatusText(images().length, 'single', columns())); }}>Single</button>
      <label class="y-text-sm">Cols <input
        type="number"
        min="1"
        max="8"
        value=${() => columns()}
        style="width:64px"
        class="y-input"
        onchange=${(e: Event) => {
          const c = clampColumns(Number((e.target as HTMLInputElement).value));
          setColumns(c);
          setStatus(makeStatusText(images().length, mode(), c));
        }}
      /></label>
      <button class="y-btn y-btn-sm y-btn-danger" onClick=${() => setImages([], true)}>Clear</button>
    </div>
    <div class="main">
      <aside class="sidebar">
        <div class="side-head y-p-2 y-text-xs y-text-muted y-border-b">Loaded Images</div>
        <div class="thumbs y-scroll">
          <${Show} when=${() => images().length === 0}>
            <div class="empty">No images loaded.</div>
          </${Show}>
          <${For} each=${images}>${(item: ImageItem) => html`
            <button class=${() => 'thumb' + (selectedIds().has(item.id) ? ' active' : '')} onClick=${() => selectImage(item)}>
              <img src="${item.source}" alt="${item.name}"/>
              <div>${item.name}</div>
            </button>
          `}</${For}>
        </div>
      </aside>
      <div class="viewer-wrap">
        <div style="width:100%;min-height:0;">
          <${Show} when=${() => images().length === 0}>
            <div class="empty">Load files or send images via App Protocol.</div>
          </${Show}>
          <${Show} when=${() => images().length > 0}>
            <div
              class=${() => mode() === 'single' ? 'viewer-single' : 'viewer-grid'}
              style=${() => mode() === 'grid' ? `--cols:${Math.max(1, columns())}` : ''}
            >
              <${For} each=${getShowItems}>${(item: ImageItem) => html`
                <div class="panel">
                  <div class="panel-head">${item.name}</div>
                  <img src="${item.source}" alt="${item.name}"/>
                </div>
              `}</${For}>
            </div>
          </${Show}>
        </div>
      </div>
    </div>
    <div class="status y-text-xs y-text-muted">${() => status()}</div>
  </div>
`, document.getElementById('app')!);

if (app) setupProtocol(app);
