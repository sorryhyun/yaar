/// <reference lib="dom" />
/**
 * @bundled/yaar — Tiny reactive DOM library for YAAR apps.
 *
 * Pure browser ES module. No Node.js APIs.
 * Provides: signals, computed, effects, hyperscript DOM, list rendering, toast.
 *
 * This file is excluded from server tsc (it's a browser library).
 * Compiled at runtime by the Bun plugin for @bundled/yaar imports.
 */

// ── Reactivity ──────────────────────────────────────────────────────────────

type Computation = { execute(): void; dependencies: Set<SignalImpl<any>> };

let currentListener: Computation | null = null;
const batchQueue = new Set<Computation>();
let batchDepth = 0;

function startBatch() {
  batchDepth++;
}

function endBatch() {
  if (--batchDepth === 0) {
    const pending = [...batchQueue];
    batchQueue.clear();
    for (const c of pending) c.execute();
  }
}

class SignalImpl<T> {
  _value: T;
  _subscribers = new Set<Computation>();

  constructor(value: T) {
    this._value = value;
  }

  get value(): T {
    if (currentListener) {
      this._subscribers.add(currentListener);
      currentListener.dependencies.add(this);
    }
    return this._value;
  }

  set value(v: T) {
    if (Object.is(this._value, v)) return;
    this._value = v;
    for (const sub of [...this._subscribers]) {
      if (batchDepth > 0) batchQueue.add(sub);
      else sub.execute();
    }
  }

  peek(): T {
    return this._value;
  }
}

export interface Signal<T> {
  (): T;
  (value: T): void;
  value: T;
  peek(): T;
}

export function signal<T>(initial: T): Signal<T> {
  const s = new SignalImpl(initial);
  const accessor = ((...args: any[]) => {
    if (args.length === 0) return s.value;
    s.value = args[0];
  }) as Signal<T>;
  Object.defineProperty(accessor, 'value', {
    get: () => s.value,
    set: (v: T) => {
      s.value = v;
    },
  });
  accessor.peek = () => s.peek();
  return accessor;
}

export function computed<T>(fn: () => T): Signal<T> {
  const s = new SignalImpl<T>(undefined as T);
  const comp: Computation = {
    dependencies: new Set(),
    execute() {
      cleanup(comp);
      const prev = currentListener;
      currentListener = comp;
      try {
        s._value = fn();
        // Notify subscribers of the computed signal
        for (const sub of [...s._subscribers]) {
          if (batchDepth > 0) batchQueue.add(sub);
          else sub.execute();
        }
      } finally {
        currentListener = prev;
      }
    },
  };
  // Initial computation
  const prev = currentListener;
  currentListener = comp;
  try {
    s._value = fn();
  } finally {
    currentListener = prev;
  }

  const accessor = (() => s.value) as Signal<T>;
  Object.defineProperty(accessor, 'value', { get: () => s.value });
  accessor.peek = () => s.peek();
  return accessor;
}

function cleanup(comp: Computation) {
  for (const dep of comp.dependencies) dep._subscribers.delete(comp);
  comp.dependencies.clear();
}

export function effect(fn: () => void | (() => void)): () => void {
  let cleanupFn: (() => void) | void;
  const comp: Computation = {
    dependencies: new Set(),
    execute() {
      cleanup(comp);
      if (cleanupFn) cleanupFn();
      const prev = currentListener;
      currentListener = comp;
      try {
        cleanupFn = fn();
      } finally {
        currentListener = prev;
      }
    },
  };
  comp.execute();
  return () => {
    cleanup(comp);
    if (cleanupFn) cleanupFn();
  };
}

export function batch(fn: () => void): void {
  startBatch();
  try {
    fn();
  } finally {
    endBatch();
  }
}

// ── DOM ─────────────────────────────────────────────────────────────────────

export type Child = string | number | boolean | null | undefined | Node | Child[] | (() => Child);

export type Props = Record<string, any> | null;

export function h(tag: string, props?: Props, ...children: Child[]): HTMLElement {
  // Parse tag: "div.foo.bar#baz" → tag=div, classes=[foo,bar], id=baz
  let tagName = tag;
  const classes: string[] = [];
  let id: string | undefined;

  const idIdx = tag.indexOf('#');
  const classIdx = tag.indexOf('.');
  const firstSpecial = Math.min(idIdx >= 0 ? idIdx : Infinity, classIdx >= 0 ? classIdx : Infinity);

  if (firstSpecial < Infinity) {
    tagName = tag.slice(0, firstSpecial) || 'div';
    const rest = tag.slice(firstSpecial);
    const parts = rest.split(/(?=[.#])/);
    for (const p of parts) {
      if (p[0] === '.') classes.push(p.slice(1));
      else if (p[0] === '#') id = p.slice(1);
    }
  }

  const el = document.createElement(tagName);
  if (id) el.id = id;
  if (classes.length) el.classList.add(...classes);

  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (key === 'className') {
        if (typeof val === 'function') {
          effect(() => {
            el.className = [classes.join(' '), val()].filter(Boolean).join(' ');
          });
        } else {
          if (classes.length) el.className = classes.join(' ') + ' ' + val;
          else el.className = val;
        }
      } else if (key === 'style') {
        if (typeof val === 'string') {
          el.style.cssText = val;
        } else if (typeof val === 'object') {
          for (const [sk, sv] of Object.entries(val as Record<string, any>)) {
            if (typeof sv === 'function') {
              effect(() => {
                (el.style as any)[sk] = sv();
              });
            } else {
              (el.style as any)[sk] = sv;
            }
          }
        }
      } else if (key.startsWith('on')) {
        const event = key.slice(2).toLowerCase();
        el.addEventListener(event, val);
      } else if (typeof val === 'function' && !key.startsWith('on')) {
        effect(() => {
          const v = val();
          if (v == null || v === false) el.removeAttribute(key);
          else el.setAttribute(key, String(v));
        });
      } else {
        if (val == null || val === false) {
          /* skip */
        } else if (val === true) el.setAttribute(key, '');
        else el.setAttribute(key, String(val));
      }
    }
  }

  appendChildren(el, children);
  return el;
}

function appendChildren(parent: Node, children: Child[]) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) {
      appendChildren(parent, child);
    } else if (typeof child === 'function') {
      const marker = document.createTextNode('');
      parent.appendChild(marker);
      let current: Node = marker;
      effect(() => {
        const val = child();
        const node = toNode(val);
        current.replaceWith(node);
        current = node;
      });
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

function toNode(val: Child): Node {
  if (val == null || val === false || val === true) return document.createTextNode('');
  if (val instanceof Node) return val;
  if (Array.isArray(val)) {
    const frag = document.createDocumentFragment();
    appendChildren(frag, val);
    return frag;
  }
  return document.createTextNode(String(val));
}

export function mount(element: Node, container?: HTMLElement): void {
  const target = container || document.getElementById('app');
  if (!target) throw new Error('Mount target not found');
  target.appendChild(element);
}

// ── List Rendering ──────────────────────────────────────────────────────────

export function list<T>(
  container: HTMLElement,
  items$: Signal<T[]>,
  renderFn: (item: T, index: number) => HTMLElement,
  key?: (item: T) => string | number,
): () => void {
  const nodeMap = new Map<string | number, HTMLElement>();
  let prevKeys: (string | number)[] = [];

  return effect(() => {
    const items = items$();
    const newKeys = key ? items.map((item) => key(item)) : items.map((_item, idx) => idx);

    // Remove old nodes not in new keys
    const newKeySet = new Set(newKeys);
    for (const k of prevKeys) {
      if (!newKeySet.has(k)) {
        const node = nodeMap.get(k);
        if (node) {
          node.remove();
          nodeMap.delete(k);
        }
      }
    }

    // Create or reorder
    const frag = document.createDocumentFragment();
    const newNodes: HTMLElement[] = [];
    for (let i = 0; i < items.length; i++) {
      const k = newKeys[i];
      let node = nodeMap.get(k);
      if (!node) {
        node = renderFn(items[i], i);
        nodeMap.set(k, node);
      }
      newNodes.push(node);
    }

    // Batch DOM update
    for (const node of newNodes) frag.appendChild(node);
    container.replaceChildren(frag);

    prevKeys = newKeys;
  });
}

// ── Toast ───────────────────────────────────────────────────────────────────

export const Toast = {
  _el: null as HTMLElement | null,
  _timer: 0,

  show(message: string, type: 'info' | 'success' | 'error' = 'info', duration = 3000): void {
    if (!this._el) {
      this._el = document.createElement('div');
      this._el.className = 'y-toast';
      document.body.appendChild(this._el);
    }
    clearTimeout(this._timer);
    this._el.textContent = message;
    this._el.className = `y-toast y-toast-${type} y-toast-visible`;
    this._timer = window.setTimeout(() => {
      if (this._el) this._el.classList.remove('y-toast-visible');
    }, duration);
  },
};
