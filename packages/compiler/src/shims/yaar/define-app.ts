// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * `defineApp()` — the single blessed entrypoint for an app.
 *
 * ```ts
 * export default defineApp({
 *   id: 'memo',
 *   name: 'Memo',
 *   state: { memoCount: { description: 'Saved memos', get: () => memos().length } },
 *   commands: { addMemo: { description: 'Create a memo', replay: 'never', run: (p) => add(p.text) } },
 *   view: App,
 * });
 * ```
 *
 * It is the only way an app registers — the iframe SDK's registration entry is
 * private (`__registerApp`) and this is its one caller — and it owns the three
 * things every app used to re-decide by hand:
 *
 * - **Registration timing.** Exactly once, at module scope, before the view
 *   mounts. Apps used to call `app.register()` from `onMount` or a bare
 *   component body, which re-runs on remount, so the SDK had to tolerate a
 *   second registration and guess whether it was a remount or two apps sharing
 *   an iframe. With this the only caller, that ambiguity is gone: a second
 *   registration is unconditionally an error.
 * - **Mounting.** `render(view, #app)` — or `view.mount(#app)` for imperative
 *   apps — instead of every app repeating the lookup and the `!`.
 * - **The `run` error contract.** A thrown plain `Error` becomes an
 *   `AppCommandError`, collapsing the four error conventions apps invented.
 *
 * The authoring shape is deliberately *not* the registration shape: `get`/`run`
 * read better than `handler`/`handler`, and the translation happens here so the
 * build-time extractor gets one canonical object literal to read.
 */

import { render } from 'solid-js/web';
import { AppCommandError, isEditableTarget, parseShortcut, shortcutMatches } from './ui.js';

/**
 * The id of the mount element the compiler's HTML wrapper emits.
 *
 * Duplicated from `APP_MOUNT_ID` in `../../mount-guard.ts` on purpose: this file
 * is browser code bundled into the app, and importing a compiler-internal module
 * would drag the compiler into every app bundle. A test asserts the two literals
 * still agree, so a rename fails the suite instead of silently mounting nothing.
 */
const APP_MOUNT_ID = 'app';

/** The SDK's `app` object, or undefined outside a YAAR iframe (see `mountView`). */
function sdkApp() {
  return typeof window === 'undefined' ? undefined : window.yaar && window.yaar.app;
}

/**
 * Normalize anything thrown by a `run` into an `AppCommandError`.
 *
 * The iframe bridge stringifies whatever comes out, so today an app's failures
 * reach the agent as `Error: ...`, `AppCommandError: ...`, or a bare string
 * depending on which convention that app picked. One shape, and the original is
 * kept as `cause` so a devtools console still has the stack.
 */
function asCommandError(thrown) {
  // Cross-realm safety: an error thrown from another bundle instance fails
  // `instanceof` but still carries the name.
  if (thrown instanceof AppCommandError || (thrown && thrown.name === 'AppCommandError')) {
    return thrown;
  }
  const wrapped = new AppCommandError(thrown instanceof Error ? thrown.message : String(thrown));
  wrapped.cause = thrown;
  return wrapped;
}

/**
 * The manifest this app's build extracted, handed back by the compiler.
 *
 * A Zod `params` is a schema object at runtime, and the SDK serves
 * `registration.commands[x].params` to agents verbatim — so without this the
 * agent-facing manifest would be a serialized Zod internal instead of JSON
 * Schema. The conversion cannot happen here (it needs `toJSONSchema`, and
 * bundling zod into every app to convert schemas most apps do not have is the
 * wrong trade), so the build does it and returns the result. See
 * `generateHtmlWrapper`.
 *
 * Absent when an app runs from a build that predates this, or in a test that
 * imports the shim directly — the authored value is then used as-is, which is
 * exactly today's behavior for a JSON-Schema literal.
 */
function buildManifest() {
  const value = typeof window === 'undefined' ? undefined : window.__yaar_manifest__;
  return value && typeof value === 'object' ? value : undefined;
}

/** The build's JSON Schema for one descriptor property, if it has one. */
function foldedSchema(manifest, section, key, prop) {
  const bag = manifest && manifest[section];
  const descriptor = bag && bag[key];
  const value = descriptor && descriptor[prop];
  return value && typeof value === 'object' ? value : undefined;
}

/**
 * True for a Standard Schema — Zod v4, Valibot, ArkType and anything else that
 * implements the spec.
 *
 * The spec interface is what this file validates through, rather than Zod's own
 * `parse`: `@bundled/zod` maps to `zod/mini`, whose schemas deliberately carry no
 * methods (parsing there is `z.parse(schema, value)`), so a `.parse` check would
 * be false for the very library the docs point apps at.
 */
function isStandardSchema(value) {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    !!value['~standard'] &&
    typeof value['~standard'].validate === 'function'
  );
}

/** How many issues a rejection names before it starts summarizing. */
const MAX_REPORTED_ISSUES = 5;

/** Turn Standard Schema issues into one line an agent can act on. */
function issuesToMessage(name, issues) {
  const shown = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = (issue.path || [])
      .map((seg) => (seg && typeof seg === 'object' ? seg.key : seg))
      .join('.');
    return (path ? path + ': ' : '') + issue.message;
  });
  const extra = issues.length - shown.length;
  return (
    name + ': invalid params - ' + shown.join('; ') + (extra > 0 ? ' (and ' + extra + ' more)' : '')
  );
}

/**
 * Take the validated value, or throw naming what was wrong with the call.
 *
 * The gap this closes: the iframe bridge checks `required` and unknown keys
 * against `properties`, but never a declared *type* — a param declared
 * `{type: 'number'}` accepted a string, and the handler failed further down with
 * a message about its own logic. A schema that can parse is a schema that can
 * say so here, where the contract is.
 */
function takeValidated(name, outcome) {
  if (outcome && outcome.issues && outcome.issues.length) {
    throw new AppCommandError(issuesToMessage(name, outcome.issues));
  }
  return outcome ? outcome.value : undefined;
}

/**
 * Adapt a `run` to the SDK's `handler(params, ctx)` contract.
 *
 * `ctx` is passed straight through — a command replayed at a remounted iframe is
 * indistinguishable from a fresh call otherwise, and `ctx.replayed` is how a
 * handler opts into replay-aware behavior instead of a blanket `replay: 'never'`.
 *
 * `validate`, when the command declared a parseable schema, runs first and hands
 * `run` the *parsed* value — so defaults, coercions and transforms have already
 * been applied and the handler's parameter is the type its schema describes.
 */
function wrapRun(name, run, validate) {
  const invoke = (params, ctx) => {
    let result;
    try {
      result = run(params, ctx);
    } catch (err) {
      throw asCommandError(err);
    }
    if (result && typeof result.then === 'function') {
      return result.then(undefined, (err) => {
        throw asCommandError(err);
      });
    }
    return result;
  };

  return (params, ctx) => {
    if (!validate) return invoke(params, ctx);
    // A bare call carries no params at all; `{}` is what a schema of all-optional
    // fields expects to see, and what the bridge already substitutes downstream.
    const outcome = validate(params === undefined || params === null ? {} : params);
    if (outcome && typeof outcome.then === 'function') {
      return outcome.then((settled) => invoke(takeValidated(name, settled), ctx));
    }
    return invoke(takeValidated(name, outcome), ctx);
  };
}

/**
 * Resolve one declared schema to the JSON Schema the manifest should carry.
 *
 * Build output wins over the authored value whenever there is one, so a Zod
 * schema never reaches an agent as an opaque object; a plain literal round-trips
 * to itself.
 */
function manifestSchema(manifest, section, key, prop, authored) {
  const folded = foldedSchema(manifest, section, key, prop);
  if (folded !== undefined) return folded;
  // Without the build's answer, a schema object would serialize as its own
  // internals. Omitting it costs the agent a contract; showing it costs the
  // agent a contract *and* misleads.
  if (isStandardSchema(authored)) return undefined;
  return authored;
}

/** Translate the authoring shape into the registration shape the iframe SDK serves. */
function toRegistration(definition) {
  const manifest = buildManifest();

  const state = {};
  const sourceState = definition.state || {};
  for (const key of Object.keys(sourceState)) {
    const entry = sourceState[key];
    const descriptor = {
      description: entry.description,
      // Called through the entry so a method-shorthand `get()` keeps its `this`.
      handler: () => entry.get(),
    };
    const schema = manifestSchema(manifest, 'state', key, 'schema', entry.schema);
    if (schema !== undefined) descriptor.schema = schema;
    state[key] = descriptor;
  }

  const commands = {};
  const sourceCommands = definition.commands || {};
  for (const name of Object.keys(sourceCommands)) {
    const entry = sourceCommands[name];
    const validate = isStandardSchema(entry.params)
      ? (params) => entry.params['~standard'].validate(params)
      : undefined;
    const descriptor = {
      description: entry.description,
      handler: wrapRun(name, (params, ctx) => entry.run(params, ctx), validate),
    };
    if (entry.aliases !== undefined) descriptor.aliases = entry.aliases;
    const params = manifestSchema(manifest, 'commands', name, 'params', entry.params);
    if (params !== undefined) descriptor.params = params;
    const returns = manifestSchema(manifest, 'commands', name, 'returns', entry.returns);
    if (returns !== undefined) descriptor.returns = returns;
    // Passed through untouched: the injected SDK reads `replay` to build the
    // `noReplay` list it sends with the ready handshake.
    if (entry.replay !== undefined) descriptor.replay = entry.replay;
    commands[name] = descriptor;
  }

  const registration = {
    appId: definition.id,
    name: definition.name,
    state,
    commands,
  };
  if (definition.events !== undefined) registration.events = definition.events;
  if (definition.onCapture !== undefined) registration.onCapture = definition.onCapture;
  if (definition.keybindings !== undefined) registration.keybindings = definition.keybindings;
  return registration;
}

/**
 * Wire `keybindings: { combo: commandName }` to the registered command handlers.
 *
 * One listener for the whole table, dispatching through the same wrapped
 * handler the iframe bridge calls — so a keypress and an agent `command` run
 * identical validation and error normalization. The build gate is what rejects
 * bad combos and unknown commands with a location; the checks here only keep a
 * directly-imported shim (tests, old builds) from silently binding nothing.
 *
 * Returns the cleanup, or undefined when nothing was installed.
 */
function installKeybindings(keybindings, commands) {
  if (
    !keybindings ||
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof window.addEventListener !== 'function'
  ) {
    return undefined;
  }

  const bindings = [];
  for (const combo of Object.keys(keybindings)) {
    const command = keybindings[combo];
    const parsed = parseShortcut(combo);
    if (!parsed) {
      console.error(`[yaar] defineApp keybindings: unparseable combo "${combo}"`);
      continue;
    }
    const descriptor = commands[command];
    if (!descriptor) {
      console.error(
        `[yaar] defineApp keybindings: "${combo}" is bound to "${command}", which is not a declared command`,
      );
      continue;
    }
    const bare = !parsed.ctrl && !parsed.meta && !parsed.alt;
    bindings.push({ parsed, bare, combo, handler: descriptor.handler });
  }
  if (bindings.length === 0) return undefined;

  const listener = (e) => {
    for (const binding of bindings) {
      if (!shortcutMatches(binding.parsed, e)) continue;
      if (binding.bare && isEditableTarget(e.target)) return;
      e.preventDefault();
      let result;
      try {
        result = binding.handler(undefined, { replayed: false });
      } catch (err) {
        console.error(`[yaar] keybinding "${binding.combo}" failed:`, err);
        return;
      }
      if (result && typeof result.then === 'function') {
        result.then(undefined, (err) => {
          console.error(`[yaar] keybinding "${binding.combo}" failed:`, err);
        });
      }
      return;
    }
  };

  window.addEventListener('keydown', listener);
  return () => window.removeEventListener('keydown', listener);
}

/**
 * Mount `view` into the one element the compiler emits.
 *
 * The guards are load-bearing, not defensive noise. This module is imported in
 * two environments that have no DOM at all: the build-time schema fold runs an
 * app's entry module in a headless subprocess to read its default export, and
 * unit tests import it directly. Both need `defineApp(...)` at module scope to
 * be *import-safe* — it must register nothing it cannot register and mount
 * nothing it cannot mount, rather than throwing on `document`/`window`. Please
 * do not "simplify" `typeof document !== 'undefined'` away.
 *
 * Returns the view's cleanup, if it has one.
 */
function mountView(view) {
  if (!view) return undefined;
  if (typeof document === 'undefined') return undefined;
  const el = document.getElementById(APP_MOUNT_ID);
  if (!el) return undefined;

  // The escape hatch, not an afterthought: imperative apps (a spreadsheet grid, a
  // video editor canvas) own their own DOM and cannot express a view as a Solid
  // component. `{ mount(el) }` is what lets them adopt defineApp at all.
  if (typeof view.mount === 'function') return view.mount(el) || undefined;

  if (typeof view === 'function') return render(view, el);

  console.error(
    '[yaar] defineApp({ view }): expected a Solid component or an object with a mount(el) method, got ' +
      typeof view,
  );
  return undefined;
}

/**
 * Register and mount an app. Returns the definition unchanged — the default
 * export stays inspectable, which is what lets the build read it statically.
 */
export function defineApp(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new Error('[yaar] defineApp(definition) requires a definition object { id, name, ... }.');
  }

  let cleanup;
  let removeKeybindings;
  const registration = toRegistration(definition);
  // Composed rather than assigned: a `{ mount }` view returning a teardown means
  // that teardown should run on window close, and the app's own onClose must
  // still run first (and still run when the view has no teardown).
  registration.onClose = () => {
    try {
      if (typeof definition.onClose === 'function') definition.onClose();
    } finally {
      if (typeof removeKeybindings === 'function') removeKeybindings();
      if (typeof cleanup === 'function') cleanup();
    }
  };

  const app = sdkApp();
  if (app) {
    // The private entry, not `app.register` — that name now only throws, to catch
    // pre-defineApp app source reaching for it.
    app.__registerApp(registration);
  } else if (typeof window !== 'undefined') {
    // A browser with no SDK is a real defect (the app-protocol script is injected
    // ahead of app code by the compiler, so it cannot lose the race). No window at
    // all is the headless import above, and is silent by design.
    console.error(
      '[yaar] defineApp("' +
        definition.id +
        '"): window.yaar.app is missing, so the app protocol is not registered. ' +
        'This app is not running inside a YAAR app window.',
    );
  }

  removeKeybindings = installKeybindings(definition.keybindings, registration.commands);
  cleanup = mountView(definition.view);
  return definition;
}
