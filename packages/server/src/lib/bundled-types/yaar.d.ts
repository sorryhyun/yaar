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

  // ── DOM ─────────────────────────────────────────────────────────────────

  /** Valid child types for h(). */
  type Child =
    | string
    | number
    | boolean
    | null
    | undefined
    | Node
    | Child[]
    | (() => Child);

  /** Props object for h(). */
  type Props = Record<string, any> | null;

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
   * mount(h('div.y-app', null, h('h1', null, 'Hello')));
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
