/// <reference lib="dom" />

// ── Reactivity ──────────────────────────────────────────────────────────────

export type Computation = {
  execute(): void;
  dependencies: Set<SignalImpl<any>>;
  cleanups: (() => void)[];
};

export let currentListener: Computation | null = null;
export let currentCleanups: (() => void)[] | null = null;
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

export class SignalImpl<T> {
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
    cleanups: [],
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
  for (const fn of comp.cleanups) fn();
  comp.cleanups = [];
}

export function effect(fn: () => void | (() => void)): () => void {
  let returnCleanup: (() => void) | void;
  const comp: Computation = {
    dependencies: new Set(),
    cleanups: [],
    execute() {
      cleanup(comp);
      if (returnCleanup) returnCleanup();
      const prev = currentListener;
      const prevCleanups = currentCleanups;
      currentListener = comp;
      currentCleanups = comp.cleanups;
      try {
        returnCleanup = fn();
      } finally {
        currentListener = prev;
        currentCleanups = prevCleanups;
      }
    },
  };
  comp.execute();
  return () => {
    cleanup(comp);
    if (returnCleanup) returnCleanup();
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

export function onCleanup(fn: () => void): void {
  if (currentCleanups) currentCleanups.push(fn);
}

export function onMount(fn: () => void): void {
  queueMicrotask(fn);
}

export function untrack<T>(fn: () => T): T {
  const prev = currentListener;
  currentListener = null;
  try {
    return fn();
  } finally {
    currentListener = prev;
  }
}
