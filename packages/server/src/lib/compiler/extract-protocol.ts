/**
 * Extract App Protocol manifest from compiled HTML.
 *
 * Runs the bundled app script in a sandboxed VM with DOM stubs,
 * intercepts the `window.yaar.app.register()` call, and returns
 * the state/command descriptors (without handler functions).
 *
 * Best-effort: returns null if extraction fails for any reason.
 */

import vm from 'node:vm';
import type { AppManifest } from '@yaar/shared';

type Protocol = Pick<AppManifest, 'state' | 'commands'>;

/**
 * Create a recursive no-op Proxy that absorbs any property access,
 * function call, or construction without throwing.
 */
function createDomStub(): unknown {
  const handler: ProxyHandler<CallableFunction> = {
    get: (_target, prop) => {
      // Prevent being treated as a Promise/thenable
      if (prop === 'then') return undefined;
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === Symbol.iterator) return undefined;
      if (prop === 'length') return 0;
      if (prop === 'toString') return () => '';
      if (prop === 'valueOf') return () => 0;
      return createDomStub();
    },
    set: () => true,
    apply: () => createDomStub(),
    construct: () => createDomStub() as object,
    has: () => true,
    deleteProperty: () => true,
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: undefined }),
  };
  return new Proxy(function () {}, handler);
}

/**
 * Extract app protocol manifest from compiled HTML content.
 * Returns null if no protocol is found or extraction fails.
 */
export function extractProtocolFromHtml(html: string): Protocol | null {
  // Extract the app script (type="module" in body, after SDK scripts in head)
  const match = html.match(/<script type="module">\n?([\s\S]*?)\n?<\/script>/);
  if (!match) return null;

  // Strip ESM syntax that vm.Script can't handle
  let script = match[1];
  script = script.replace(/\bexport\s*\{[^}]*\}/g, '');
  script = script.replace(/\bexport\s+default\b/g, 'var __default =');
  // Replace import.meta references (common in bundled ESM)
  script = script.replace(/\bimport\.meta\.url\b/g, '"about:blank"');
  script = script.replace(/\bimport\.meta/g, '({})');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let captured: any = null;
  const domStub = createDomStub();

  const context = vm.createContext({
    // Core: the register trap
    window: new Proxy({} as Record<string, unknown>, {
      get: (_target, prop) => {
        if (prop === 'yaar')
          return {
            app: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              register: (config: any) => {
                captured = config;
              },
              sendInteraction: () => {},
            },
          };
        if (prop === 'addEventListener' || prop === 'removeEventListener') return () => {};
        if (prop === 'parent') return { postMessage: () => {} };
        if (prop === 'location') return { href: '', origin: '', pathname: '/', search: '' };
        if (prop === 'innerWidth') return 800;
        if (prop === 'innerHeight') return 600;
        if (prop === 'devicePixelRatio') return 1;
        if (prop === 'requestAnimationFrame') return () => 0;
        if (prop === 'cancelAnimationFrame') return () => {};
        if (prop === 'setTimeout') return () => 0;
        if (prop === 'clearTimeout') return () => {};
        if (prop === 'setInterval') return () => 0;
        if (prop === 'clearInterval') return () => {};
        if (prop === 'getComputedStyle') return () => domStub;
        if (prop === 'matchMedia')
          return () => ({ matches: false, addEventListener: () => {}, addListener: () => {} });
        return domStub;
      },
      set: () => true,
      has: () => true,
    }),

    // Browser globals (all point to stubs)
    document: domStub,
    self: domStub,
    navigator: { userAgent: '', clipboard: domStub, language: 'en' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    performance: { now: () => 0, mark: () => {}, measure: () => {} },
    queueMicrotask: () => {},

    // Timers (no-op, don't execute callbacks)
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},

    // Constructors
    Image: class {
      width = 0;
      height = 0;
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
     
    CustomEvent: class {},
     
    Event: class {},
    DOMParser: class {
      parseFromString() {
        return domStub;
      }
    },
    WebSocket: class {
      send() {}
      close() {}
    },
    AudioContext: class {
      createOscillator() {
        return domStub;
      }
      createGain() {
        return domStub;
      }
    },
     
    Blob: class {},
    FileReader: class {
      readAsDataURL() {}
    },

    // JS builtins (needed since vm context doesn't inherit them)
    console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Symbol,
    BigInt,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    RegExp,
    Proxy,
    Reflect,
    Error,
    TypeError,
    RangeError,
    ReferenceError,
    Date,
    Math,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Headers,
    Request,
    Response,
    ArrayBuffer,
    DataView,
    Uint8Array,
    Int8Array,
    Float32Array,
    Float64Array,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURI,
    decodeURI,
    encodeURIComponent,
    decodeURIComponent,
    atob,
    btoa,
    structuredClone,
    fetch: () => Promise.resolve(domStub),
    crypto: {
      randomUUID: () => '00000000-0000-0000-0000-000000000000',
      getRandomValues: (a: unknown) => a,
    },
    undefined,
    NaN,
    Infinity,
  });

  try {
    const vmScript = new vm.Script(script, { filename: 'protocol-extract.js' });
    vmScript.runInContext(context, { timeout: 3000 });
  } catch {
    // Ignore — we just want whatever register() captured before the error
  }

  if (!captured) return null;

  // Build protocol from captured config (strip handler functions, keep metadata)
  const protocol: Protocol = { state: {}, commands: {} };

  if (captured.state && typeof captured.state === 'object') {
    for (const [key, val] of Object.entries(captured.state)) {
      if (key === 'manifest') continue; // Built-in, skip
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = val as any;
      if (v && typeof v.description === 'string') {
        protocol.state[key] = { description: v.description };
        if (v.schema) protocol.state[key].schema = v.schema;
      }
    }
  }

  if (captured.commands && typeof captured.commands === 'object') {
    for (const [key, val] of Object.entries(captured.commands)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = val as any;
      if (v && typeof v.description === 'string') {
        protocol.commands[key] = { description: v.description };
        if (v.params) protocol.commands[key].params = v.params;
        if (v.returns) protocol.commands[key].returns = v.returns;
      }
    }
  }

  if (Object.keys(protocol.state).length === 0 && Object.keys(protocol.commands).length === 0) {
    return null;
  }

  return protocol;
}
