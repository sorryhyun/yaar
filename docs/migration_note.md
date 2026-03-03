# Migration Guide: `@bundled/yaar` → `@bundled/solid-js`

`@bundled/yaar` is deprecated. New apps should use `@bundled/solid-js`. This guide covers migrating existing apps.

## Import Changes

```ts
// Before
import { signal, computed, effect, batch, onMount, onCleanup, untrack, h, html, css, mount, list, show, createResource, Toast } from '@bundled/yaar';

// After
import { createSignal, createMemo, createEffect, batch, onMount, onCleanup, untrack, Show, For, createResource } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
```

## API Mapping

| `@bundled/yaar` | `@bundled/solid-js` | Notes |
|---|---|---|
| `signal(val)` | `createSignal(val)` | Returns `[getter, setter]` tuple instead of a single function |
| `sig()` (read) | `getter()` | Same call syntax |
| `sig(val)` (write) | `setter(val)` | Separate function |
| `sig.peek()` | `untrack(() => getter())` | No `.peek()` — use `untrack` |
| `sig.value` | N/A | Use getter/setter |
| `computed(fn)` | `createMemo(fn)` | Same semantics |
| `effect(fn)` | `createEffect(fn)` | Same semantics; use `onCleanup` inside for cleanup |
| `batch(fn)` | `batch(fn)` | Identical |
| `onMount(fn)` | `onMount(fn)` | Identical |
| `onCleanup(fn)` | `onCleanup(fn)` | Identical |
| `untrack(fn)` | `untrack(fn)` | Identical |
| `mount(el)` | `render(() => el, document.getElementById('app')!)` | Explicit container |
| `html\`...\`` | `html\`...\`` (from `solid-js/html`) | Same tagged template syntax |
| `h(tag, props, ...children)` | `html\`<tag ...>...</tag>\`` | No hyperscript; use `html` |
| `css\`...\`` | `import './styles.css'` | Use CSS file imports |
| `show(when, content, fallback?)` | Ternary or `<Show>` component | See below |
| `list(container, items$, renderFn, key?)` | `<For each={items()}>` | See below |
| `createResource(fetcher)` | `createResource(fetcher)` | Slightly different API — see below |
| `Toast.show(msg, type?, ms?)` | Inline toast (see below) | No built-in Toast |

## Pattern-by-Pattern Migration

### 1. Signals

```ts
// Before
const count = signal(0);
count();        // read
count(count() + 1); // write

// After
const [count, setCount] = createSignal(0);
count();        // read
setCount(c => c + 1); // write (setter supports updater fn)
```

### 2. Mounting

```ts
// Before
mount(html`<div class="y-app">...</div>`);

// After
render(() => html`<div class="y-app">...</div>`, document.getElementById('app')!);
```

### 3. Conditional Rendering (`show` → ternary / `Show`)

```ts
// Before
${show(() => loading(), () => html`<div class="y-spinner"></div>`)}
${show(() => !!data(), () => html`<div>${() => data()}</div>`, () => html`<div>Empty</div>`)}

// After — ternary (simpler for most cases)
${() => loading() ? html`<div class="y-spinner"></div>` : ''}
${() => data() ? html`<div>${data()}</div>` : html`<div>Empty</div>`}

// After — Show component (preserves referential identity)
<${Show} when=${data} fallback=${html`<div>Empty</div>`}>${(d: Data) => html`<div>${d}</div>`}</${Show}>
```

### 4. List Rendering (`list` → `For`)

```ts
// Before
list(container, items, (item) => html`<div>${item.name}</div>`, (item) => item.id);

// After
<${For} each=${items}>${(item: Item) => html`<div>${item.name}</div>`}</${For}>
```

### 5. Async Resources

```ts
// Before
const data = createResource(() => fetch('/api').then(r => r.json()));
data();          // read
data.loading();  // boolean signal
data.error();    // Error | null signal
data.refetch();  // re-trigger

// After
const [data, { refetch }] = createResource(() => fetch('/api').then(r => r.json()));
data();          // read
data.loading;    // boolean (reactive)
data.error;      // Error | undefined (reactive)
refetch();       // re-trigger
```

### 6. Toast Notifications

```ts
// Before
import { Toast } from '@bundled/yaar';
Toast.show('Saved!', 'success');

// After — inline helper (uses y-toast CSS classes already available)
function showToast(msg: string, type: 'info' | 'success' | 'error' = 'info', ms = 3000) {
  const el = document.createElement('div');
  el.className = `y-toast y-toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
showToast('Saved!', 'success');
```

### 7. CSS Injection

```ts
// Before
import { css } from '@bundled/yaar';
css`.sidebar { width: 240px; }`;

// After — use CSS file import (preferred)
import './styles.css';
```

### 8. Refs

```ts
// Before
let el!: HTMLDivElement;
html`<div ref=${(e: HTMLDivElement) => { el = e; }}>...</div>`;

// After — same pattern works with solid-js/html
let el!: HTMLDivElement;
html`<div ref=${(e: HTMLDivElement) => { el = e; }}>...</div>`;
```

## Full Before/After Example

### Before (`@bundled/yaar`)

```ts
export {};
import { signal, html, mount, show, Toast } from '@bundled/yaar';
import './styles.css';

type Todo = { id: number; text: string; done: boolean };
const todos = signal<Todo[]>([]);
let nextId = 1;

function addTodo(text: string) {
  todos([...todos(), { id: nextId++, text, done: false }]);
  Toast.show('Added!', 'success');
}

mount(html`
  <div class="y-app y-p-3">
    <h2>Todos</h2>
    ${() => todos().map(t => html`<div class="y-card">${t.text}</div>`)}
    ${show(() => !todos().length, () => html`<div class="y-text-muted">No todos yet</div>`)}
  </div>
`);
```

### After (`@bundled/solid-js`)

```ts
export {};
import { createSignal, For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';

function showToast(msg: string, type = 'info', ms = 3000) {
  const el = document.createElement('div');
  el.className = `y-toast y-toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

type Todo = { id: number; text: string; done: boolean };
const [todos, setTodos] = createSignal<Todo[]>([]);
let nextId = 1;

function addTodo(text: string) {
  setTodos(prev => [...prev, { id: nextId++, text, done: false }]);
  showToast('Added!', 'success');
}

render(() => html`
  <div class="y-app y-p-3">
    <h2>Todos</h2>
    <${For} each=${todos}>${(t: Todo) => html`<div class="y-card">${t.text}</div>`}</${For}>
    ${() => !todos().length ? html`<div class="y-text-muted">No todos yet</div>` : ''}
  </div>
`, document.getElementById('app')!);
```

## Checklist per App

1. Replace `import { ... } from '@bundled/yaar'` with solid-js imports
2. Convert `signal(v)` → `createSignal(v)` (destructure to `[getter, setter]`)
3. Update all write sites: `sig(val)` → `setter(val)`
4. Replace `mount(el)` → `render(() => el, document.getElementById('app')!)`
5. Replace `show(when, content, fallback?)` → ternary or `<Show>`
6. Replace `list(...)` → `<For>`
7. Replace `computed(fn)` → `createMemo(fn)`
8. Replace `effect(fn)` → `createEffect(fn)`
9. Replace `Toast.show(...)` → inline `showToast` helper
10. Replace `css\`...\`` → `import './styles.css'`
11. Verify the app compiles and renders correctly
