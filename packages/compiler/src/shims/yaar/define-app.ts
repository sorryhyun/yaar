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
 * It is sugar over `app.register()` plus build-time legibility, and it owns the
 * three things every app was re-deciding by hand:
 *
 * - **Registration timing.** Exactly once, at module scope, before the view
 *   mounts. Five shipped apps register from `onMount` or a bare component body,
 *   which re-runs on remount; the SDK's per-window guard cannot reject those
 *   (they are legitimate remounts), so it only rejects a second registration
 *   landing on an *authoritative* one. `__authoritative: true` below is that
 *   opt-in: a `defineApp` app declares that this window is its own and a second
 *   `register()` is two apps fighting over one iframe, not a remount.
 * - **Mounting.** `render(view, #app)` — or `view.mount(#app)` for imperative
 *   apps — instead of every app repeating the lookup and the `!`.
 * - **The `run` error contract.** A thrown plain `Error` becomes an
 *   `AppCommandError`, collapsing the four error conventions apps invented.
 *
 * The authoring shape is deliberately *not* the registration shape: `get`/`run`
 * read better than `handler`/`handler`, and the translation happens here so the
 * build-time extractor gets one canonical object literal to read instead of
 * hunting for whichever `register()` call executed last.
 */

import { render } from 'solid-js/web';
import { AppCommandError } from './ui.js';

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
 * Adapt a `run` to the SDK's `handler(params, ctx)` contract.
 *
 * `ctx` is passed straight through — a command replayed at a remounted iframe is
 * indistinguishable from a fresh call otherwise, and `ctx.replayed` is how a
 * handler opts into replay-aware behavior instead of a blanket `replay: 'never'`.
 */
function wrapRun(run) {
  return (params, ctx) => {
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
}

/** Translate the authoring shape into the `app.register()` shape. */
function toRegistration(definition) {
  const state = {};
  const sourceState = definition.state || {};
  for (const key of Object.keys(sourceState)) {
    const entry = sourceState[key];
    const descriptor = {
      description: entry.description,
      // Called through the entry so a method-shorthand `get()` keeps its `this`.
      handler: () => entry.get(),
    };
    if (entry.schema !== undefined) descriptor.schema = entry.schema;
    state[key] = descriptor;
  }

  const commands = {};
  const sourceCommands = definition.commands || {};
  for (const name of Object.keys(sourceCommands)) {
    const entry = sourceCommands[name];
    const descriptor = {
      description: entry.description,
      handler: wrapRun((params, ctx) => entry.run(params, ctx)),
    };
    if (entry.aliases !== undefined) descriptor.aliases = entry.aliases;
    if (entry.params !== undefined) descriptor.params = entry.params;
    if (entry.returns !== undefined) descriptor.returns = entry.returns;
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
    __authoritative: true,
  };
  if (definition.events !== undefined) registration.events = definition.events;
  if (definition.onCapture !== undefined) registration.onCapture = definition.onCapture;
  return registration;
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
  const registration = toRegistration(definition);
  // Composed rather than assigned: a `{ mount }` view returning a teardown means
  // that teardown should run on window close, and the app's own onClose must
  // still run first (and still run when the view has no teardown).
  registration.onClose = () => {
    try {
      if (typeof definition.onClose === 'function') definition.onClose();
    } finally {
      if (typeof cleanup === 'function') cleanup();
    }
  };

  const app = sdkApp();
  if (app) {
    app.register(registration);
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

  cleanup = mountView(definition.view);
  return definition;
}
