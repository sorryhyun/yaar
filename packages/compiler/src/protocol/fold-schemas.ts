/**
 * Fold a `defineApp` app's schemas by *running* it.
 *
 * The AST extractor reads `params`/`returns`/`schema` as constants. A Zod schema
 * is not one — `z.object({...})` is a builder chain whose JSON Schema only exists
 * after it executes. Teaching the static evaluator Zod's API would be a treadmill
 * (the alternative considered in the proposal), so instead the compiler executes
 * the app the same way `Bun.build` and `tsc` already do, and asks the resulting
 * definition object what its schemas are.
 *
 * Three properties make this safe enough to be the answer:
 *
 *  - **It only runs when something could not be folded statically.** An app whose
 *    schemas are JSON-Schema literals never reaches this file, so adopting Zod is
 *    the only way to pay for it.
 *  - **It runs in a Worker, not this thread.** App module scope is arbitrary code;
 *    a hang would otherwise freeze the server, and a global it assigns would leak
 *    into the compiler. `terminate()` on a timeout closes both.
 *  - **The zod instance is the app's own.** The fold entry imports `@bundled/zod`
 *    through the same plugin the app build uses, so `toJSONSchema` and the schema
 *    it is handed always come from one copy — in a normal build *and* inside the
 *    bundled exe, where the only zod that exists is the prebundled artifact.
 *
 * The result is also what lifts bundled-exe mode's refusal to build `defineApp`
 * apps: with no `typescript` there is no AST extractor, but the running app can
 * still be asked, and its answer is by construction the one the iframe will serve.
 *
 * Nothing here silently degrades. A schema that cannot be folded, an app that
 * throws on import, a worker that hangs — each returns a failure the caller turns
 * into a build error naming the descriptor.
 */

import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import type { AppManifest } from '@yaar/shared';
import { listKeybindingIssues } from '@yaar/shared';
import { buildAppBundle, formatBuildLogs } from '../build/build-app.js';

type Protocol = Pick<AppManifest, 'state' | 'commands' | 'events' | 'keybindings'>;

export interface FoldSuccess {
  ok: true;
  /** `defineApp({ id })` as the running app declares it. */
  id: string | undefined;
  name: string | undefined;
  /** The manifest the running definition describes, schemas already folded. */
  protocol: Protocol;
  /**
   * Descriptor paths (`commands.x.params`) whose value was a Standard Schema
   * rather than a JSON-Schema literal — i.e. the ones this pass actually folded.
   */
  folded: string[];
}

export interface FoldFailure {
  ok: false;
  /** ASCII, single or multi-line. Compiler error paths mangle non-ASCII bytes. */
  error: string;
}

export type FoldResult = FoldSuccess | FoldFailure;

export interface FoldOptions {
  /**
   * The app root. The fold always builds `<appPath>/src/main.ts`, deliberately:
   * that is the compiler's own entry point, and `defineApp` is anchored to the
   * entry module's default export. An app that hides its registration in another
   * module is reported as having no default export, which is the right diagnosis
   * rather than a near miss.
   */
  appPath: string;
  /** `app.json` `bundles`, so a gated SDK resolves as it does in the app build. */
  bundles?: string[];
  /** Milliseconds before the worker is terminated. */
  timeoutMs?: number;
}

/** How long an app's module scope may run before we call it hung. */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Where the fold's scratch files live. Inside `dist/` because it is gitignored,
 * already created by the compile, and — unlike a temp directory — guaranteed to
 * be on the same drive as `src/`, so the entry's relative import resolves on
 * Windows too.
 */
const FOLD_DIR = '.yaar-fold';

/**
 * Globals the app's module scope may touch before `defineApp` ever runs.
 *
 * This is not defensive padding. The `@bundled/yaar` barrel reads `window.yaar`
 * at *module scope* (`shims/yaar/verbs.ts`), so a compiled entry module dies on
 * import in a bare worker before any of the app's own code executes. `defineApp`
 * guards its own DOM access precisely so it is import-safe; the barrel below it
 * does not, and this prelude is the other half of that contract.
 *
 * `document` is stubbed rather than omitted so an app touching the DOM at module
 * scope survives, and `getElementById` answers null so `defineApp`'s mount is a
 * no-op — a Solid render inside a worker is exactly what we do not want.
 */
const WORKER_PRELUDE = `
// --- YAAR schema fold: browser-global stubs (see fold-schemas.ts) ---
const __yaarInert = new Proxy(function () {}, {
  get(_t, prop) {
    // A thenable would make every \`await\` on a stub hang forever, and a symbol
    // read (Symbol.toPrimitive, Symbol.iterator) must not answer with a function.
    if (prop === 'then' || typeof prop === 'symbol') return undefined;
    return __yaarInert;
  },
  apply: () => __yaarInert,
  construct: () => __yaarInert,
  has: () => true,
  set: () => true,
});
const __yaarStub = (own) =>
  new Proxy(own, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return __yaarInert;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
const __yaarStorage = __yaarStub({
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
});
const __yaarDocument = __yaarStub({
  // null is what makes defineApp's mount a no-op.
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementsByTagName: () => [],
  getElementsByClassName: () => [],
  createElement: () => __yaarInert,
  createElementNS: () => __yaarInert,
  createTextNode: () => __yaarInert,
  createDocumentFragment: () => __yaarInert,
  addEventListener: () => {},
  removeEventListener: () => {},
  documentElement: __yaarInert,
  body: __yaarInert,
  head: __yaarInert,
  readyState: 'complete',
  title: '',
  cookie: '',
});
const __yaarWindow = __yaarStub({
  // __registerApp is defineApp's private entry — named explicitly so the fold
  // exercises the same call the iframe does, rather than the inert catch-all.
  yaar: __yaarStub({ app: __yaarStub({ __registerApp: () => {}, emit: () => {}, sendInteraction: () => {} }) }),
  document: __yaarDocument,
  location: { href: 'https://yaar.invalid/', origin: 'https://yaar.invalid', protocol: 'https:', host: 'yaar.invalid', hostname: 'yaar.invalid', pathname: '/', search: '', hash: '' },
  navigator: { userAgent: 'yaar-schema-fold', language: 'en-US', languages: ['en-US'] },
  localStorage: __yaarStorage,
  sessionStorage: __yaarStorage,
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  matchMedia: () => ({ matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }),
  getComputedStyle: () => __yaarInert,
  // Reachable network would make a build depend on the world. Failing is honest.
  fetch: () => Promise.reject(new Error('[yaar] network is unavailable while folding schemas')),
  innerWidth: 1024,
  innerHeight: 768,
  devicePixelRatio: 1,
});
// A distinct object, not globalThis: the worker's own postMessage is how the
// fold reports back, and an app calling window.parent.postMessage must not
// reach it.
globalThis.window = __yaarWindow;
globalThis.self = globalThis.self || __yaarWindow;
globalThis.document = __yaarDocument;
globalThis.localStorage = __yaarStorage;
globalThis.sessionStorage = __yaarStorage;
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = __yaarWindow.navigator;
if (typeof globalThis.location === 'undefined') globalThis.location = __yaarWindow.location;
if (typeof globalThis.HTMLElement === 'undefined') globalThis.HTMLElement = class {};
if (typeof globalThis.Element === 'undefined') globalThis.Element = class {};
if (typeof globalThis.Node === 'undefined') globalThis.Node = class {};
if (typeof globalThis.customElements === 'undefined') globalThis.customElements = __yaarInert;
if (typeof globalThis.requestAnimationFrame === 'undefined') globalThis.requestAnimationFrame = () => 0;
// Bare, not just on window: anime.js calls cancelAnimationFrame at module scope,
// so an app whose graph reaches it died on import with a ReferenceError.
if (typeof globalThis.cancelAnimationFrame === 'undefined') globalThis.cancelAnimationFrame = () => {};
if (typeof globalThis.matchMedia === 'undefined') globalThis.matchMedia = __yaarWindow.matchMedia;
// --- end stubs ---
`;

/**
 * The fold entry, bundled together with the app so `toJSONSchema` and the
 * schemas it reads come from one zod instance.
 *
 * A namespace import rather than `import definition from` so an app with no
 * default export is reported here, as a fold failure naming the entry, instead
 * of failing the bundle with a message about a missing export.
 */
const FOLD_ENTRY_SOURCE = `
import * as toolkit from '@bundled/zod';
import * as appModule from '../../src/main';

const problems = [];
const folded = [];

const isStandardSchema = (value) =>
  !!value &&
  (typeof value === 'object' || typeof value === 'function') &&
  typeof value['~standard'] === 'object' &&
  value['~standard'] !== null &&
  typeof value['~standard'].validate === 'function';

/**
 * A descriptor schema, as the manifest wants it: a Standard Schema becomes JSON
 * Schema, a plain object passes through, anything else is a problem.
 *
 * \`io\` distinguishes the two directions: \`params\` describes what a caller must
 * send (input, before defaults and transforms), \`returns\` what the app answers
 * with (output).
 */
function foldSchema(value, path, io) {
  if (value === undefined || value === null) return undefined;
  if (isStandardSchema(value)) {
    if (typeof toolkit.toJSONSchema !== 'function') {
      problems.push(path + ': a schema object needs zod\\'s toJSONSchema to reach the manifest');
      return undefined;
    }
    try {
      const json = toolkit.toJSONSchema(value, { io: io });
      // Every descriptor schema is an inline subschema of protocol.json; a
      // per-entry \$schema is noise in the agent's context.
      delete json.\$schema;
      folded.push(path);
      return json;
    } catch (err) {
      problems.push(path + ': ' + (err && err.message ? err.message : String(err)));
      return undefined;
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  problems.push(path + ': expected a JSON Schema object or a Zod schema, got ' + typeof value);
  return undefined;
}

function describedString(value, path) {
  if (typeof value === 'string') return value;
  problems.push(path + ': missing a string \`description\`');
  return undefined;
}

function buildProtocol(definition) {
  const protocol = { state: {}, commands: {} };

  const stateSource = definition.state || {};
  for (const key of Object.keys(stateSource)) {
    if (key === 'manifest') continue; // built-in, served by the SDK
    const entry = stateSource[key] || {};
    const path = 'state.' + key;
    const description = describedString(entry.description, path);
    if (description === undefined) continue;
    const descriptor = { description: description };
    const schema = foldSchema(entry.schema, path + '.schema', 'output');
    if (schema !== undefined) descriptor.schema = schema;
    protocol.state[key] = descriptor;
  }

  const commandSource = definition.commands || {};
  for (const key of Object.keys(commandSource)) {
    const entry = commandSource[key] || {};
    const path = 'commands.' + key;
    const description = describedString(entry.description, path);
    if (description === undefined) continue;
    const descriptor = { description: description };
    if (entry.aliases !== undefined) descriptor.aliases = entry.aliases;
    if (entry.replay !== undefined) descriptor.replay = entry.replay;
    const params = foldSchema(entry.params, path + '.params', 'input');
    if (params !== undefined) descriptor.params = params;
    const returns = foldSchema(entry.returns, path + '.returns', 'output');
    if (returns !== undefined) descriptor.returns = returns;
    protocol.commands[key] = descriptor;
  }

  if (definition.events) {
    const events = {};
    for (const key of Object.keys(definition.events)) {
      const entry = definition.events[key] || {};
      const description = describedString(entry.description, 'events.' + key);
      if (description === undefined) continue;
      events[key] = { description: description };
    }
    if (Object.keys(events).length > 0) protocol.events = events;
  }

  // Combos and command names are checked host-side (listKeybindingIssues) so the
  // fold and the AST reader reject identically; here only the shape is read.
  if (definition.keybindings) {
    const keybindings = {};
    for (const key of Object.keys(definition.keybindings)) {
      const command = definition.keybindings[key];
      if (typeof command !== 'string') {
        problems.push('keybindings.' + key + ': expected a command name string');
        continue;
      }
      keybindings[key] = command;
    }
    if (Object.keys(keybindings).length > 0) protocol.keybindings = keybindings;
  }

  return protocol;
}

try {
  const definition = appModule.default;
  if (!definition || typeof definition !== 'object') {
    postMessage({
      ok: false,
      error:
        'src/main.ts has no \`export default defineApp({...})\`; the running definition is what ' +
        'this pass reads, so the default export must be the app',
    });
  } else {
    const protocol = buildProtocol(definition);
    postMessage({
      ok: true,
      id: typeof definition.id === 'string' ? definition.id : undefined,
      name: typeof definition.name === 'string' ? definition.name : undefined,
      protocol: protocol,
      folded: folded,
      problems: problems,
    });
  }
} catch (err) {
  postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
`;

/** Keep an error readable in a compiler message that may pass through ASCII-only paths. */
function asAscii(text: string): string {
  return text.replace(/[^\x20-\x7e\n]/g, '?');
}

interface WorkerReply {
  ok: boolean;
  error?: string;
  id?: string;
  name?: string;
  protocol?: Protocol;
  folded?: string[];
  problems?: string[];
}

/**
 * Run `source` in a Worker and wait for its single `postMessage`.
 *
 * A Worker rather than a subprocess because the bundled exe has no `bun` binary
 * to spawn — `process.execPath` there is the YAAR executable, which would
 * relaunch the server. A worker also gives what a subprocess would: separate
 * globals, and a `terminate()` that actually stops a runaway module scope.
 */
async function runInWorker(scriptPath: string, timeoutMs: number): Promise<WorkerReply> {
  const worker = new Worker(Bun.pathToFileURL(scriptPath).href);
  try {
    return await new Promise<WorkerReply>((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          ok: false,
          error:
            `the app did not finish importing within ${Math.round(timeoutMs / 1000)}s. ` +
            'Module scope runs during the fold, so a top-level await on something that ' +
            'never settles will hang it',
        });
      }, timeoutMs);

      worker.addEventListener('message', (event: unknown) => {
        clearTimeout(timer);
        resolve((event as { data: WorkerReply }).data);
      });
      worker.addEventListener('error', (event: unknown) => {
        clearTimeout(timer);
        const message = (event as { message?: string })?.message;
        resolve({
          ok: false,
          error: `the app threw while being imported: ${message || 'unknown error'}`,
        });
      });
    });
  } finally {
    worker.terminate();
  }
}

/**
 * Build the app together with a fold entry and ask the running definition for
 * its manifest.
 *
 * Failure is always a `FoldFailure` with a message the caller can print; this
 * never throws for an app's own fault.
 */
export async function foldAppSchemas(options: FoldOptions): Promise<FoldResult> {
  const { appPath, bundles, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const foldDir = join(appPath, 'dist', FOLD_DIR);
  const entryPath = join(foldDir, 'entry.ts');
  const workerPath = join(foldDir, 'worker.mjs');

  try {
    await mkdir(foldDir, { recursive: true });
    await Bun.write(entryPath, FOLD_ENTRY_SOURCE);

    // The same build the compiler runs, minus minification — this bundle is
    // never shipped, and a readable stack is the difference between "the app
    // threw" and knowing where.
    const built = await buildAppBundle(entryPath, { minify: false, bundles });

    if (!built.success || !built.outputs[0]) {
      const logs = formatBuildLogs(built.logs).join('; ');
      return {
        ok: false,
        error: asAscii(`the app could not be bundled for folding: ${logs || 'no output produced'}`),
      };
    }

    // The prelude has to run before the app's module scope, and the bundle is
    // self-contained (Bun inlines every import), so prepending is enough — no
    // second file and no import ordering to get wrong.
    await Bun.write(workerPath, `${WORKER_PRELUDE}\n${await built.outputs[0].text()}`);

    const reply = await runInWorker(workerPath, timeoutMs);
    if (!reply.ok || !reply.protocol) {
      return { ok: false, error: asAscii(reply.error ?? 'the app reported no manifest') };
    }
    if (reply.problems && reply.problems.length > 0) {
      return { ok: false, error: asAscii(reply.problems.join('\n')) };
    }
    if (reply.protocol.keybindings) {
      const issues = listKeybindingIssues(
        reply.protocol.keybindings,
        Object.keys(reply.protocol.commands),
      );
      if (issues.length > 0) {
        return {
          ok: false,
          error: asAscii(issues.map((i) => `keybindings.${i.combo}: ${i.issue}`).join('\n')),
        };
      }
    }

    return {
      ok: true,
      id: reply.id,
      name: reply.name,
      protocol: reply.protocol,
      folded: reply.folded ?? [],
    };
  } catch (err) {
    return {
      ok: false,
      error: asAscii(err instanceof Error ? err.message : String(err)),
    };
  } finally {
    await rm(foldDir, { recursive: true, force: true }).catch(() => {});
  }
}
