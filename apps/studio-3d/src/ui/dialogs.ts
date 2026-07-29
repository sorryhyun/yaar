/**
 * dialogs.ts — the storage browser, the URL prompt and the saved-scene list.
 * All three share one modal shell.
 */
import html from '@bundled/solid-js/html';
import { For, Show, createSignal } from '@bundled/solid-js';
import { listStorage, type StorageEntry } from '../io';
import { isSupportedName, SUPPORTED_EXTENSIONS } from '../loaders';
import {
  listSavedScenes,
  loadFromStorage,
  loadFromUrl,
  openSavedScene,
  reportError,
  reportInfo,
} from '../store';

export type DialogMode = 'none' | 'storage' | 'url' | 'scenes';

const [mode, setMode] = createSignal<DialogMode>('none');
const [cwd, setCwd] = createSignal('');
const [entries, setEntries] = createSignal<StorageEntry[]>([]);
const [scenes, setScenes] = createSignal<string[]>([]);
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal('');
const [url, setUrl] = createSignal('');

export const dialogMode = mode;

export function closeDialog(): void {
  setMode('none');
  setError('');
}

async function browseTo(dir: string): Promise<void> {
  setLoading(true);
  setError('');
  try {
    const items = await listStorage(dir);
    setCwd(dir);
    setEntries(items);
  } catch (e) {
    setEntries([]);
    setError(`Could not list "${dir || '/'}". ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    setLoading(false);
  }
}

export function openStorageBrowser(): void {
  setMode('storage');
  void browseTo(cwd());
}

export function openUrlPrompt(): void {
  setMode('url');
  setError('');
}

export async function openScenePicker(): Promise<void> {
  setMode('scenes');
  setLoading(true);
  setError('');
  try {
    setScenes(await listSavedScenes());
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  } finally {
    setLoading(false);
  }
}

async function choose(entry: StorageEntry): Promise<void> {
  if (entry.isDirectory) {
    await browseTo(entry.path);
    return;
  }
  closeDialog();
  try {
    const out = await loadFromStorage(entry.path);
    reportInfo(`Loaded ${out.name} — ${out.meshes} mesh(es), ${out.tris.toLocaleString()} tris`);
  } catch (e) {
    reportError(e, `loading ${entry.path}`);
  }
}

async function submitUrl(): Promise<void> {
  const value = url().trim();
  if (!value) return;
  closeDialog();
  try {
    const out = await loadFromUrl(value);
    reportInfo(`Loaded ${out.name} — ${out.meshes} mesh(es), ${out.tris.toLocaleString()} tris`);
  } catch (e) {
    reportError(e, 'loading from URL');
  }
}

async function openScene(path: string): Promise<void> {
  closeDialog();
  try {
    await openSavedScene(path);
    reportInfo(`Opened ${path}`);
  } catch (e) {
    reportError(e, `opening ${path}`);
  }
}

function parentDir(dir: string): string {
  const clean = dir.replace(/\/+$/, '');
  const i = clean.lastIndexOf('/');
  return i < 0 ? '' : clean.slice(0, i);
}

interface Crumb {
  label: string;
  path: string;
}

function crumbs(): Crumb[] {
  const out: Crumb[] = [{ label: 'storage', path: '' }];
  let acc = '';
  for (const part of cwd().split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : part;
    out.push({ label: part, path: acc });
  }
  return out;
}

function summary(): string {
  const items = entries();
  const dirs = items.filter((e) => e.isDirectory).length;
  const files = items.length - dirs;
  const models = items.filter((e) => !e.isDirectory && isSupportedName(e.name)).length;
  const parts = [`${dirs} folder${dirs === 1 ? '' : 's'}`, `${files} file${files === 1 ? '' : 's'}`];
  if (models > 0) parts.push(`${models} loadable`);
  return parts.join(' · ');
}

function storageBody() {
  return html`
    <div class="dlg-path">
      <button
        class="btn btn-icon"
        disabled=${() => cwd() === ''}
        onClick=${() => void browseTo(parentDir(cwd()))}
        title="Up one level"
      >
        ↑
      </button>
      <div class="crumbs">
        <${For} each=${() => crumbs()}>
          ${(c: Crumb, i: () => number) =>
            html`<span class="crumb-wrap">
              <${Show} when=${() => i() > 0}><span class="crumb-sep">/</span><//>
              <button class="crumb" onClick=${() => void browseTo(c.path)} title=${`yaar://storage/${c.path}`}>
                ${c.label}
              </button>
            </span>`}
        <//>
      </div>
    </div>
    <div class="dlg-body">
      <${Show} when=${() => loading()}>
        <div class="file-row dim">Loading…</div>
      <//>
      <${Show} when=${() => !!error()}>
        <div class="warn">${() => error()}</div>
      <//>
      <${Show} when=${() => cwd() !== '' && !loading()}>
        <div class="file-row" onClick=${() => void browseTo(parentDir(cwd()))}>
          <span class="file-ico">↩</span>
          <span class="file-name">..</span>
          <span class="file-hint">parent folder</span>
        </div>
      <//>
      <${Show} when=${() => !loading() && entries().length === 0 && !error()}>
        <div class="file-row dim">Empty folder</div>
      <//>
      <${For} each=${() => entries()}>
        ${(entry: StorageEntry) => {
          const supported = entry.isDirectory || isSupportedName(entry.name);
          return html`<div
            class=${supported ? 'file-row' : 'file-row dim'}
            title=${`yaar://storage/${entry.path}`}
            onClick=${() => (supported ? void choose(entry) : undefined)}
          >
            <span class="file-ico">${entry.isDirectory ? '📁' : supported ? '🧊' : '·'}</span>
            <span class="file-name">${entry.name}</span>
            <span class="file-hint">${entry.isDirectory ? '›' : (entry.hint ?? '')}</span>
          </div>`;
        }}
      <//>
    </div>
    <div class="dlg-note">
      <span>${() => (loading() ? '…' : summary())}</span>
      <span>${SUPPORTED_EXTENSIONS.join(' ')}</span>
    </div>
  `;
}

function urlBody() {
  return html`
    <div class="dlg-path">Fetched through the YAAR HTTP proxy (allowlisted domains only).</div>
    <div class="dlg-body">
      <div class="url-form">
        <input
          class="txt"
          placeholder="https://example.com/model.glb"
          value=${() => url()}
          onInput=${(e: InputEvent) => setUrl((e.currentTarget as HTMLInputElement).value)}
          onKeyDown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') void submitUrl();
          }}
        />
        <button class="btn btn-primary" onClick=${() => void submitUrl()}>Load</button>
      </div>
      <div class="warn">Supported: ${SUPPORTED_EXTENSIONS.join(', ')}</div>
    </div>
  `;
}

function scenesBody() {
  return html`
    <div class="dlg-path">Saved in this app's private storage.</div>
    <div class="dlg-body">
      <${Show} when=${() => loading()}>
        <div class="file-row dim">Loading…</div>
      <//>
      <${Show} when=${() => !loading() && scenes().length === 0}>
        <div class="file-row dim">No saved scenes yet — use “Save” in the toolbar.</div>
      <//>
      <${For} each=${() => scenes()}>
        ${(path: string) =>
          html`<div class="file-row" onClick=${() => void openScene(path)}>
            <span class="file-ico">🗂</span><span>${path}</span>
          </div>`}
      <//>
    </div>
  `;
}

const TITLES: Record<string, string> = {
  storage: 'Open from storage',
  url: 'Load from URL',
  scenes: 'Open saved scene',
};

export function Dialogs() {
  return html`<${Show} when=${() => mode() !== 'none'}>
    <div class="mask" onClick=${(e: MouseEvent) => {
      if ((e.target as HTMLElement).classList.contains('mask')) closeDialog();
    }}>
      <div class="dlg">
        <div class="dlg-h">
          <span>${() => TITLES[mode()] ?? ''}</span>
          <button class="btn btn-icon" onClick=${closeDialog}>✕</button>
        </div>
        ${() => {
          const m = mode();
          if (m === 'storage') return storageBody();
          if (m === 'url') return urlBody();
          if (m === 'scenes') return scenesBody();
          return null;
        }}
        <div class="dlg-f">
          <button class="btn" onClick=${closeDialog}>Close</button>
        </div>
      </div>
    </div>
  <//>`;
}
