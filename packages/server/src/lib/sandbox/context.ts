/**
 * Sandbox context module.
 *
 * Provides safe globals and context creation for vm-based code execution.
 */

import { createHash } from 'node:crypto';
import vm from 'node:vm';

/** Console log entry with level and arguments */
export interface LogEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  args: unknown[];
  timestamp: number;
}

/** Captured console that stores log entries */
export interface CapturedConsole {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  getLogs: () => LogEntry[];
  clear: () => void;
}

/**
 * Create a console that captures all output to an array.
 */
export function createCapturedConsole(): CapturedConsole {
  const logs: LogEntry[] = [];

  const createLogger =
    (level: LogEntry['level']) =>
    (...args: unknown[]) => {
      logs.push({ level, args, timestamp: Date.now() });
    };

  return {
    log: createLogger('log'),
    info: createLogger('info'),
    warn: createLogger('warn'),
    error: createLogger('error'),
    debug: createLogger('debug'),
    getLogs: () => [...logs],
    clear: () => {
      logs.length = 0;
    },
  };
}

/**
 * Format captured logs as a string.
 */
export function formatLogs(logs: LogEntry[]): string {
  if (logs.length === 0) return '';

  return logs
    .map((entry) => {
      const prefix = entry.level === 'log' ? '[LOG]' : `[${entry.level.toUpperCase()}]`;
      const argsStr = entry.args
        .map((arg) => {
          if (typeof arg === 'string') return arg;
          try {
            return JSON.stringify(arg, null, 2);
          } catch {
            return String(arg);
          }
        })
        .join(' ');
      return `${prefix} ${argsStr}`;
    })
    .join('\n');
}

/**
 * Safe globals whitelist for the sandbox.
 * These are frozen copies of built-in objects that don't provide system access.
 */
export function createSafeGlobals(capturedConsole: CapturedConsole): Record<string, unknown> {
  return {
    // Console (captured)
    console: Object.freeze({
      log: capturedConsole.log,
      info: capturedConsole.info,
      warn: capturedConsole.warn,
      error: capturedConsole.error,
      debug: capturedConsole.debug,
    }),

    // JSON utilities
    JSON: Object.freeze({
      parse: JSON.parse,
      stringify: JSON.stringify,
    }),

    // Math utilities
    Math: Object.freeze({ ...Math }),

    // Date (frozen constructor)
    Date,

    // Primitive constructors and utilities
    Object,
    Array,
    String,
    Number,
    Boolean,
    Symbol,
    BigInt,

    // Collections
    Map,
    Set,
    WeakMap,
    WeakSet,

    // Regular expressions
    RegExp,

    // Error types
    Error,
    TypeError,
    RangeError,
    ReferenceError,
    SyntaxError,
    URIError,
    EvalError,
    AggregateError,

    // URL parsing (read-only, no network)
    URL,
    URLSearchParams,

    // Text encoding
    TextEncoder,
    TextDecoder,

    // Base64
    atob,
    btoa,

    // Number parsing/checking
    parseInt,
    parseFloat,
    isNaN,
    isFinite,

    // URI encoding
    encodeURI,
    decodeURI,
    encodeURIComponent,
    decodeURIComponent,

    // Promise (for async patterns within sync execution)
    Promise,

    // Typed arrays (useful for data processing)
    ArrayBuffer,
    SharedArrayBuffer,
    DataView,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,

    // Structured clone (useful for deep copying)
    structuredClone,

    // undefined and NaN/Infinity
    undefined,
    NaN,
    Infinity,

    // Reflection (limited, for object inspection)
    Reflect: Object.freeze({
      get: Reflect.get,
      has: Reflect.has,
      ownKeys: Reflect.ownKeys,
      getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
      getPrototypeOf: Reflect.getPrototypeOf,
      isExtensible: Reflect.isExtensible,
    }),

    // Crypto (pure computation only — no system access, no network, no I/O)
    crypto: Object.freeze({
      createHash,
    }),
  };
}

/**
 * Create a sandboxed vm context with safe globals.
 */
export function createSandboxContext(capturedConsole: CapturedConsole): vm.Context {
  const globals = createSafeGlobals(capturedConsole);
  const context = vm.createContext(globals, {
    name: 'sandbox',
    codeGeneration: {
      strings: false, // Disallow eval() and new Function()
      wasm: false, // Disallow WebAssembly
    },
  });
  return context;
}
