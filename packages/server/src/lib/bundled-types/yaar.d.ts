/**
 * Type definitions for @bundled/yaar — reactive DOM library for YAAR apps.
 */

declare module '@bundled/yaar' {
  // ── Reactivity ──────────────────────────────────────────────────────────

  /**
   * A reactive signal. Call with no args to read (and track), with one arg to write.
   *
   * @example
   * const count = signal(0);
   * count();    // read → 0
   * count(1);   // write
   * count.value // read (also tracks)
   * count.peek() // read without tracking
   */
  interface Signal<T> {
    /** Read the signal value (tracks dependency). */
    (): T;
    /** Write a new value. */
    (value: T): void;
    /** Read/write via property access. */
    value: T;
    /** Read without tracking dependency. */
    peek(): T;
  }

  /**
   * Create a reactive signal with an initial value.
   *
   * @example
   * const name = signal('world');
   * effect(() => console.log(`Hello, ${name()}`));
   * name('YAAR'); // logs: Hello, YAAR
   */
  export function signal<T>(initial: T): Signal<T>;

  /**
   * Create a derived signal that auto-recomputes when dependencies change.
   *
   * @example
   * const count = signal(2);
   * const doubled = computed(() => count() * 2);
   * doubled() // → 4
   */
  export function computed<T>(fn: () => T): Signal<T>;

  /**
   * Run a side effect that re-executes when tracked signals change.
   * Returns a dispose function. The callback may return a cleanup function.
   *
   * @example
   * const dispose = effect(() => {
   *   document.title = `Count: ${count()}`;
   *   return () => { /* cleanup *\/ };
   * });
   * dispose(); // stop the effect
   */
  export function effect(fn: () => void | (() => void)): () => void;

  /**
   * Batch multiple signal writes into a single update.
   *
   * @example
   * batch(() => {
   *   firstName('Jane');
   *   lastName('Doe');
   * }); // effects run once, not twice
   */
  export function batch(fn: () => void): void;

  /**
   * Register a cleanup function within the current effect.
   * Called when the effect re-runs or is disposed.
   *
   * @example
   * effect(() => {
   *   const timer = setInterval(tick, 1000);
   *   onCleanup(() => clearInterval(timer));
   * });
   */
  export function onCleanup(fn: () => void): void;

  /**
   * Run a callback once after the current synchronous code completes.
   * Useful for setup that needs the DOM to be mounted.
   *
   * @example
   * onMount(() => {
   *   const el = document.getElementById('canvas');
   *   initChart(el);
   * });
   */
  export function onMount(fn: () => void): void;

  /**
   * Read signals without creating a dependency.
   *
   * @example
   * effect(() => {
   *   const x = count();           // tracked
   *   const y = untrack(() => other()); // NOT tracked
   * });
   */
  export function untrack<T>(fn: () => T): T;

  // ── DOM ─────────────────────────────────────────────────────────────────

  /** Valid child types for h() and html``. */
  type Child =
    | string
    | number
    | boolean
    | null
    | undefined
    | Node
    | Child[]
    | (() => Child);

  /** Props object for h(). Supports `ref` callback, `on*` events, reactive attrs. */
  type Props = Record<string, any> & { ref?: (el: HTMLElement) => void } | null;

  /**
   * Create an HTML element (hyperscript).
   * Tag supports `.class` and `#id` syntax.
   * Props: `className`, `style` (string or object), `on*` events, reactive attrs (functions).
   * Children: strings, nodes, arrays, or functions (reactive).
   *
   * @example
   * h('div.card#main', { style: { padding: '8px' } },
   *   h('h1', null, 'Title'),
   *   h('p.y-text-muted', null, () => `Count: ${count()}`),
   *   h('button.y-btn.y-btn-primary', { onClick: () => count(count() + 1) }, 'Add'),
   * )
   */
  export function h(tag: string, props?: Props, ...children: Child[]): HTMLElement;

  /**
   * Append an element to a container (defaults to `#app`).
   *
   * @example
   * mount(html`<div class="y-app"><h1>Hello</h1></div>`);
   */
  export function mount(element: Node, container?: HTMLElement): void;

  /**
   * Reactive list rendering with optional key-based reconciliation.
   *
   * @example
   * const items = signal([{ id: 1, text: 'Buy milk' }]);
   * list(
   *   container,
   *   items,
   *   (item) => h('div.y-card', null, item.text),
   *   (item) => item.id,
   * );
   */
  export function list<T>(
    container: HTMLElement,
    items$: Signal<T[]>,
    renderFn: (item: T, index: number) => HTMLElement,
    key?: (item: T) => string | number,
  ): () => void;

  // ── CSS ─────────────────────────────────────────────────────────────────

  /**
   * Inject a `<style>` element into the document head.
   *
   * @example
   * css`
   *   .sidebar { width: 240px; border-right: 1px solid var(--yaar-border); }
   *   .active { color: var(--yaar-accent); }
   * `;
   */
  export function css(strings: TemplateStringsArray, ...values: unknown[]): void;

  // ── HTML Tagged Template ────────────────────────────────────────────────

  /**
   * Tagged template for declarative DOM creation. Produces real DOM nodes
   * using the same reactive system as h(). Supports `class` (mapped to className),
   * `on*` event handlers, reactive children, and interpolated attributes.
   *
   * @example
   * const App = () => html`
   *   <div class="y-app y-p-3">
   *     <h2 class="y-text-lg">Todo</h2>
   *     <input class="y-input" placeholder="Add..." onKeydown=${handleKey} />
   *     <div class="y-text-muted">${() => `${todos().length} items`}</div>
   *     ${() => todos().map(item => html`
   *       <div class="y-card">${item.text}</div>
   *     `)}
   *   </div>
   * `;
   * mount(App());
   */
  export function html(statics: TemplateStringsArray, ...fields: unknown[]): Node;

  // ── Conditional & Async ─────────────────────────────────────────────────

  /**
   * Conditional rendering. Returns a reactive child that switches
   * between content and fallback based on a condition signal.
   *
   * @example
   * html`<div>${show(
   *   () => loading(),
   *   () => html`<div class="y-spinner"></div>`,
   *   () => html`<ul>${items().map(renderItem)}</ul>`
   * )}</div>`
   */
  export function show(
    when: () => boolean,
    content: () => Child,
    fallback?: () => Child,
  ): () => Child;

  /**
   * Async data resource with loading/error tracking.
   */
  interface Resource<T> {
    /** Read the data value (tracks dependency). */
    (): T | undefined;
    /** Whether the resource is currently loading. */
    loading: Signal<boolean>;
    /** Error from the last fetch attempt, or null. */
    error: Signal<Error | null>;
    /** Re-trigger the fetcher. */
    refetch: () => void;
  }

  /**
   * Create an async data resource. Fetches immediately and provides
   * reactive loading/error state.
   *
   * @example
   * const posts = createResource(() =>
   *   fetch('/api/posts').then(r => r.json())
   * );
   *
   * html`
   *   ${show(() => posts.loading(), () => html`<div class="y-spinner"></div>`)}
   *   ${show(() => !!posts.error(), () => html`<div class="y-text-error">${() => posts.error()?.message}</div>`)}
   *   ${() => posts()?.map(p => html`<div class="y-card">${p.title}</div>`)}
   * `
   */
  export function createResource<T>(
    fetcher: () => Promise<T>,
    options?: { initialValue?: T },
  ): Resource<T>;

  // ── Toast ─────────────────────────────────────────────────────────────

  /** Floating toast notification using y-toast CSS classes. */
  export const Toast: {
    /**
     * Show a toast message.
     *
     * @example
     * Toast.show('Saved!', 'success');
     * Toast.show('Something went wrong', 'error', 5000);
     */
    show(message: string, type?: 'info' | 'success' | 'error', duration?: number): void;
  };
}
