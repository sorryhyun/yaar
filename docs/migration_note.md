# Migration Note: Traditional Apps → `@bundled/yaar`

This guide shows how to convert existing YAAR apps from raw DOM/innerHTML patterns to the reactive `@bundled/yaar` library.

## Why Migrate?

Traditional apps use imperative DOM manipulation — `document.createElement`, `innerHTML`, manual event wiring, and full re-render functions. This works but gets painful as apps grow:

- **State → DOM sync is manual.** Every state change needs explicit DOM updates.
- **CSS injection is boilerplate.** Every app creates `<style>` elements by hand.
- **No reactivity.** Adding a feature that reacts to data changes means wiring more event listeners and update calls.

`@bundled/yaar` gives you signals (reactive state), `html` templates (declarative DOM), and auto-updating UI — in ~200 lines with zero dependencies.

## Migration Patterns

### 1. Style injection → CSS file import

**Before:**
```ts
const style = document.createElement('style');
style.textContent = `
  .sidebar { width: 240px; border-right: 1px solid var(--yaar-border); }
  .item { padding: var(--yaar-sp-2); cursor: pointer; }
  .item:hover { background: var(--yaar-bg-surface); }
`;
document.head.appendChild(style);
```

**After:**
```ts
import './styles.css';
```

```css
/* src/styles.css */
.sidebar { width: 240px; border-right: 1px solid var(--yaar-border); }
.item { padding: var(--yaar-sp-2); cursor: pointer; }
.item:hover { background: var(--yaar-bg-surface); }
```

The build plugin converts `.css` imports into runtime `<style>` injection automatically. For small inline snippets, the `css` template tag from `@bundled/yaar` still works.

### 2. Mutable state + render() → Signals

**Before:**
```ts
interface State {
  items: Item[];
  selected: string | null;
  loading: boolean;
}

const state: State = { items: [], selected: null, loading: false };

function render() {
  listEl.innerHTML = '';
  for (const item of state.items) {
    const div = document.createElement('div');
    div.className = 'item' + (item.id === state.selected ? ' active' : '');
    div.textContent = item.name;
    div.onclick = () => { state.selected = item.id; render(); };
    listEl.appendChild(div);
  }
  countEl.textContent = `${state.items.length} items`;
}

// Every state change requires calling render()
state.items = await fetchItems();
render();
```

**After:**
```ts
import { signal } from '@bundled/yaar';

const items = signal<Item[]>([]);
const selected = signal<string | null>(null);
const loading = signal(false);

// UI auto-updates when signals change — no render() calls needed
items(await fetchItems());
```

### 3. innerHTML templates → `html` tagged template

**Before:**
```ts
const app = document.getElementById('app')!;
app.innerHTML = `
  <div class="y-app y-p-3">
    <h2 class="y-text-lg">My App</h2>
    <div id="list"></div>
    <div id="status" class="y-text-muted"></div>
  </div>
`;

const listEl = document.getElementById('list')!;
const statusEl = document.getElementById('status')!;

// Then manually populate listEl and statusEl...
```

**After:**
```ts
import { signal, html, mount } from '@bundled/yaar';

const items = signal<Item[]>([]);

mount(html`
  <div class="y-app y-p-3">
    <h2 class="y-text-lg">My App</h2>
    ${() => items().map(item => html`
      <div class="y-card">${item.name}</div>
    `)}
    <div class="y-text-muted">${() => `${items().length} items`}</div>
  </div>
`);
```

### 4. Manual event wiring → Inline handlers

**Before:**
```ts
const btn = document.createElement('button');
btn.className = 'y-btn y-btn-primary';
btn.textContent = 'Save';
btn.addEventListener('click', handleSave);
container.appendChild(btn);

const input = document.createElement('input');
input.className = 'y-input';
input.placeholder = 'Search...';
input.addEventListener('input', (e) => {
  state.query = (e.target as HTMLInputElement).value;
  render();
});
container.appendChild(input);
```

**After:**
```ts
html`
  <button class="y-btn y-btn-primary" onClick=${handleSave}>Save</button>
  <input class="y-input" placeholder="Search..." onInput=${(e: Event) => {
    query((e.target as HTMLInputElement).value);
  }} />
`
```

### 5. Loading/error handling → `show()` + `createResource()`

**Before:**
```ts
const state = { data: null, loading: true, error: null };

async function fetchData() {
  state.loading = true;
  try {
    const res = await fetch('/api/data');
    state.data = await res.json();
  } catch (e) {
    state.error = e;
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  container.innerHTML = '';
  if (state.loading) {
    container.innerHTML = '<div class="y-spinner"></div>';
    return;
  }
  if (state.error) {
    container.innerHTML = `<div class="y-text-error">${state.error.message}</div>`;
    return;
  }
  // render state.data...
}
```

**After:**
```ts
import { html, mount, show, createResource } from '@bundled/yaar';

const data = createResource(() => fetch('/api/data').then(r => r.json()));

mount(html`
  <div class="y-app y-p-3">
    ${show(() => data.loading(), () => html`<div class="y-spinner"></div>`)}
    ${show(() => !!data.error(), () => html`<div class="y-text-error">${() => data.error()?.message}</div>`)}
    ${() => data()?.map(item => html`<div class="y-card">${item.name}</div>`)}
  </div>
`);
```

### 6. setInterval / setup → `onMount` + `onCleanup`

**Before:**
```ts
// Global timer — no cleanup, leaks on app reload
const timer = setInterval(() => {
  state.time = Date.now();
  render();
}, 1000);
```

**After:**
```ts
import { signal, onMount, onCleanup } from '@bundled/yaar';

const time = signal(Date.now());

onMount(() => {
  const timer = setInterval(() => time(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
});
```

### 7. Conditional class toggling → Reactive `class` attribute

**Before:**
```ts
function render() {
  el.className = 'item' + (state.active ? ' active' : '');
}
```

**After:**
```ts
html`<div class=${() => 'item' + (active() ? ' active' : '')}>...</div>`
```

### 8. show/hide panels → `show()`

**Before:**
```ts
function render() {
  detailPanel.style.display = state.selected ? 'block' : 'none';
  if (state.selected) {
    detailPanel.innerHTML = `<h3>${state.selected.name}</h3>...`;
  }
}
```

**After:**
```ts
html`
  ${show(
    () => !!selected(),
    () => html`<div class="detail"><h3>${() => selected()!.name}</h3></div>`,
  )}
`
```

### 9. getElementById / querySelector → `ref`

When you need a direct reference to a DOM element (e.g., focus, read `.value`, `contenteditable`, canvas, App Protocol state handlers), use `ref` instead of querying by ID.

**Before:**
```ts
app.innerHTML = `
  <input id="title-input" class="y-input" />
  <div id="editor" contenteditable="true"></div>
`;

const titleEl = document.getElementById('title-input') as HTMLInputElement;
const editorEl = document.getElementById('editor') as HTMLDivElement;

// Fragile — coupled to IDs, breaks if template changes
titleEl.focus();
appApi.register({
  state: { content: { description: '...', handler: () => editorEl.innerHTML } },
});
```

**After:**
```ts
let titleEl!: HTMLInputElement;
let editorEl!: HTMLDivElement;

mount(html`
  <input class="y-input" ref=${(el: HTMLInputElement) => { titleEl = el; }} />
  <div contenteditable="true" ref=${(el: HTMLDivElement) => { editorEl = el; }} />
`);

// ref fires synchronously during mount — elements available immediately
titleEl.focus();
appApi.register({
  state: { content: { description: '...', handler: () => editorEl.innerHTML } },
});
```

`ref` is a callback that receives the element. It fires synchronously during `h()` / `html`, so the variable is assigned by the time `mount()` returns. No IDs needed, no querySelector fragility.

### 10. localStorage → `window.yaar.storage`

This isn't a yaar-runtime change, but it's the most common mistake in existing apps. `localStorage` and `IndexedDB` are **not available** in the iframe sandbox. Use `window.yaar.storage` instead — it persists server-side and survives across sessions.

**Before:**
```ts
// Breaks silently in sandbox — data lost on reload
localStorage.setItem('my-app-data', JSON.stringify(state));
const saved = JSON.parse(localStorage.getItem('my-app-data') || '{}');
```

**After:**
```ts
const storage = (window as any).yaar?.storage;

// Save (async)
await storage.save('my-app/data.json', JSON.stringify(state));

// Load (async — always handle missing files)
const saved = await storage.read('my-app/data.json', { as: 'json' }).catch(() => ({}));
```

Note: `yaar.storage` is async (returns Promises), while `localStorage` is sync. Wrap load/save in async functions and handle the first-launch case where no file exists yet.

## Full Before/After Example

### Before: File Browser (traditional)

```ts
export {};

interface FileEntry { path: string; name: string; isDirectory: boolean; size: number; }

const yaar = (window as any).yaar;
const storage = yaar?.storage;

let entries: FileEntry[] = [];
let currentPath = '/';

// Style injection
const style = document.createElement('style');
style.textContent = `
  body { background: var(--yaar-bg); color: var(--yaar-text); }
  .toolbar { display: flex; gap: 8px; padding: 8px; border-bottom: 1px solid var(--yaar-border); }
  .file-row { display: flex; padding: 8px; cursor: pointer; }
  .file-row:hover { background: var(--yaar-bg-surface); }
`;
document.head.appendChild(style);

const app = document.getElementById('app')!;
app.innerHTML = `
  <div class="y-app">
    <div class="toolbar">
      <button id="btn-back" class="y-btn y-btn-sm">← Back</button>
      <span id="path" class="y-text-muted"></span>
    </div>
    <div id="list" class="y-scroll"></div>
  </div>
`;

const listEl = document.getElementById('list')!;
const pathEl = document.getElementById('path')!;

document.getElementById('btn-back')!.onclick = () => {
  if (currentPath === '/') return;
  currentPath = currentPath.replace(/\/[^/]+\/?$/, '') || '/';
  loadDir();
};

async function loadDir() {
  pathEl.textContent = currentPath;
  entries = await storage.list(currentPath);
  listEl.innerHTML = '';
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.textContent = (entry.isDirectory ? '📁 ' : '📄 ') + entry.name;
    row.onclick = () => {
      if (entry.isDirectory) { currentPath = entry.path; loadDir(); }
    };
    listEl.appendChild(row);
  }
}

loadDir();
```

### After: File Browser (yaar)

```css
/* src/styles.css */
.toolbar { display: flex; gap: 8px; padding: 8px; border-bottom: 1px solid var(--yaar-border); }
.file-row { display: flex; padding: 8px; cursor: pointer; }
.file-row:hover { background: var(--yaar-bg-surface); }
```

```ts
export {};
import { signal, html, mount, show, createResource, onMount } from '@bundled/yaar';
import './styles.css';

interface FileEntry { path: string; name: string; isDirectory: boolean; size: number; }

const yaar = (window as any).yaar;
const storage = yaar?.storage;

const currentPath = signal('/');
const entries = signal<FileEntry[]>([]);

async function loadDir() {
  entries(await storage.list(currentPath()));
}

function goBack() {
  if (currentPath() === '/') return;
  currentPath(currentPath().replace(/\/[^/]+\/?$/, '') || '/');
  loadDir();
}

function navigate(entry: FileEntry) {
  if (entry.isDirectory) { currentPath(entry.path); loadDir(); }
}

onMount(() => { loadDir(); });

mount(html`
  <div class="y-app">
    <div class="toolbar">
      <button class="y-btn y-btn-sm" onClick=${goBack}>← Back</button>
      <span class="y-text-muted">${() => currentPath()}</span>
    </div>
    <div class="y-scroll">
      ${() => entries().map(entry => html`
        <div class="file-row" onClick=${() => navigate(entry)}>
          ${entry.isDirectory ? '📁 ' : '📄 '}${entry.name}
        </div>
      `)}
    </div>
  </div>
`);
```

## Quick Reference

| Traditional Pattern | Yaar Equivalent |
|---|---|
| `document.createElement('style')` | `import './styles.css'` (or `css\`...\`` for small snippets) |
| `el.innerHTML = \`...\`` | `html\`...\`` |
| `document.createElement(tag)` | `h(tag, props, ...children)` or `html\`<tag>...\`` |
| `el.addEventListener('click', fn)` | `onClick=\${fn}` in html template |
| `el.className = ...` | `class=\${() => ...}` (reactive) |
| `state.x = val; render();` | `x(val)` (auto-updates) |
| `if (loading) showSpinner()` | `show(() => loading(), () => html\`<spinner/>\`)` |
| `fetch + loading + error` | `createResource(fetcher)` |
| `getElementById('x')` | `ref=\${(el) => { xEl = el; }}` in html template |
| `localStorage.setItem(k, v)` | `await yaar.storage.save(path, data)` |
| `localStorage.getItem(k)` | `await yaar.storage.read(path, { as: 'json' }).catch(() => null)` |
| `setInterval(fn, ms)` | `onMount(() => { const t = setInterval(fn, ms); onCleanup(() => clearInterval(t)); })` |

## Incremental Migration

You don't have to rewrite everything at once. Yaar's primitives are composable with raw DOM:

```ts
// Mix: use html`` for a section, keep existing DOM for the rest
const header = html`<div class="y-flex-between">
  <h2>${() => title()}</h2>
  <button class="y-btn" onClick=${save}>Save</button>
</div>`;

document.getElementById('app')!.prepend(header);
```

Signals work anywhere — you can adopt them for state management while keeping existing DOM code:

```ts
const count = signal(0);

// Works with existing DOM code
effect(() => {
  document.getElementById('counter')!.textContent = String(count());
});
```
