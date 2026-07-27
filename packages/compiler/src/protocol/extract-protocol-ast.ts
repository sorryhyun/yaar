/**
 * Extract App Protocol manifest from TypeScript source using the TypeScript AST.
 *
 * The registration shape is `export default defineApp({...})`, and only that.
 * The config object *is* the protocol, so there is nothing to locate by
 * heuristic — an app still calling the removed `app.register({...})` is refused
 * by name (see `findAppRegisterCall`) rather than reported as declaring no
 * protocol at all, which is the silent outcome this module exists to prevent.
 *
 * What the AST buys over the brace-matching text scanner it replaced is *reach*:
 *
 *   - descriptor maps may live in other files and arrive via `...spread`;
 *   - a descriptor may be a `const` referenced by name;
 *   - `params`/`returns`/`schema` blocks may contain `+`-concatenated strings,
 *     which the text scanner silently dropped from the manifest.
 *
 * That reach is the whole point: it makes a protocol file decomposable by domain
 * without the manifest quietly losing entries. See
 * `docs/proposals/app_protocol_manifest_proposal.md`.
 *
 * The invariant this module exists to hold: **an entry that works at runtime must
 * be visible in the static manifest.** So anything it cannot resolve is a hard
 * error with a source location, never a best-effort omission. A command an agent
 * cannot see is a command that does not exist.
 *
 * Module resolution is deliberately limited to *relative* imports within the app.
 * A descriptor reached through `node_modules` or a path alias is an error rather
 * than a silent skip. `defineAppCommand({...})` is transparent because the shim's
 * `defineAppCommand` is the identity function; any other wrapper must be provably
 * an identity function in this app, or it is an error (see
 * `isTransparentWrapper`).
 *
 * Two layers sit under this one and are read as a stack:
 * `protocol-module-graph.ts` resolves specifiers and indexes a module's bindings;
 * `protocol-extractor.ts` turns an expression into a constant. This file knows
 * what `defineApp` means, and is the only one that does.
 */

import type { AppManifest } from '@yaar/shared';
import { listKeybindingIssues } from '@yaar/shared';
import { Extractor } from './protocol-extractor.js';
import type {
  ModuleScope,
  ProtocolError,
  ReadFile,
  TsExpression,
  TsModule,
  TsNode,
} from './protocol-module-graph.js';

// The public surface is this module, whichever layer a name is declared in:
// `index.ts` and every caller outside the package import them from here.
export { formatProtocolError } from './protocol-module-graph.js';
export type { ProtocolError, ReadFile } from './protocol-module-graph.js';

type Protocol = Pick<AppManifest, 'state' | 'commands' | 'events' | 'keybindings'>;

export interface AstProtocolExtraction {
  protocol: Protocol | null;
  errors: ProtocolError[];
  /**
   * Descriptor schema paths (`commands.add.params`) that are not compile-time
   * constants and are expected to be Zod — the ones `fold-schemas.ts` must fill
   * in by running the app. Deferral is possible at all only because `defineApp`'s
   * config is reachable at runtime as the entry module's default export.
   *
   * Non-empty means `protocol` is *incomplete*, not wrong: every entry is
   * present, and the listed schemas are absent until the fold supplies them.
   */
  pendingFolds: string[];
}

/**
 * What both readers say about the removed `app.register({...})`.
 *
 * The whole design intent is that the AST path and the no-`typescript` path
 * refuse the removed shape *alike* — they find it differently (a resolved call
 * receiver vs. a text scan), but an author must not be able to tell which
 * environment answered. Two copy-pasted literals were the weakest possible way
 * to hold that.
 */
export const APP_REGISTER_REMOVED_MESSAGE =
  '`app.register({...})` has been removed. Register with `export default defineApp({ id, ' +
  "name, state, commands, view })` from '@bundled/yaar': move each `state` entry's " +
  "`handler` to `get`, each command's `handler` to `run`, and `appId` to `id`";

/** The package `defineApp` must come from for a call to be the SDK's. */
const YAAR_SDK_SPECIFIER = '@bundled/yaar';

/** True when `name` is bound in `scope` to `defineApp` from '@bundled/yaar'. */
function isDefineAppImport(scope: ModuleScope, name: string): boolean {
  const ref = scope.imports.get(name);
  return !!ref && ref.imported === 'defineApp' && ref.specifier === YAAR_SDK_SPECIFIER;
}

/**
 * True for a call this app makes to the SDK's `defineApp`.
 *
 * The named import is the canonical spelling and is matched exactly, aliases
 * included (`import { defineApp as makeApp }`). A `*.defineApp(...)` member call
 * is also taken, because a namespace import (`import * as yaar`) is not indexed
 * as a binding and would otherwise slip past and be reported as *no protocol at
 * all*, the silent outcome this module exists to prevent. An app that declares
 * its own `defineApp` is not matched: it resolves locally, so it is that app's
 * function, not the SDK's.
 */
function isDefineAppCall(ts: TsModule, node: TsNode, scope: ModuleScope): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    if (isDefineAppImport(scope, callee.text)) return true;
    // Undeclared and unimported in this app: a global the extractor cannot see
    // the definition of. Only the SDK's documented name is assumed.
    return (
      callee.text === 'defineApp' &&
      !scope.locals.has('defineApp') &&
      !scope.imports.has('defineApp')
    );
  }
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'defineApp';
  return false;
}

/** The `export default <expr>` expression of a module, if it has one. */
function defaultExportExpression(ts: TsModule, scope: ModuleScope): TsExpression | null {
  for (const statement of scope.source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) return statement.expression;
  }
  return null;
}

/**
 * True when the identifier `name` names the SDK's `app` object in `scope`.
 *
 * The named import is the canonical spelling and is matched exactly, aliases
 * included (`import { app as sdkApp }`). A name this app neither declares nor
 * imports is taken as the SDK's too, because the legacy shape reached `app`
 * through paths the module index does not bind — `const { app } = window.yaar`
 * among them — and missing those would let an unmigrated app build green. What
 * that leaves uncaught is a *non*-module-scope `const app = …`, which the scope
 * model cannot see; the module-scope declaration, which is what a library object
 * named `app` actually looks like, resolves locally and is left alone.
 */
function isSdkAppReceiver(scope: ModuleScope, name: string): boolean {
  const ref = scope.imports.get(name);
  if (ref) return ref.imported === 'app' && ref.specifier === YAAR_SDK_SPECIFIER;
  return name === 'app' && !scope.locals.has('app');
}

/**
 * The first `app.register(...)` call in the graph, if any — the removed
 * registration shape.
 *
 * This is a migration guard, not a reader. `register()` no longer exists at
 * runtime, so an app still calling it would otherwise extract to *no protocol at
 * all* and build green while every one of its commands went missing from the
 * manifest — the exact silent truncation this module exists to prevent.
 *
 * `register` is a common method name — `Chart.register(...registerables)` sits
 * in a bundled app today — so the receiver must be the SDK's `app` object, and
 * it is resolved the same way `isDefineAppCall` resolves its callee rather than
 * matched on spelling: the `app` binding imported from '@bundled/yaar' (aliases
 * included), an `app` this app neither declares nor imports (a global the
 * extractor cannot see), or a member chain ending in `.app` (`window.yaar.app`).
 * An app that declares its own `app` — `const app = registry` — is left alone;
 * that object is not the SDK's, so refusing it would fail a valid build with a
 * migration notice for an API it never called.
 */
function findAppRegisterCall(
  ts: TsModule,
  scopes: ModuleScope[],
): { node: TsNode; scope: ModuleScope } | null {
  for (const scope of scopes) {
    let found: { node: TsNode; scope: ModuleScope } | null = null;
    const visit = (node: TsNode): void => {
      if (
        !found &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'register'
      ) {
        const receiver = node.expression.expression;
        const isApp = ts.isIdentifier(receiver)
          ? isSdkAppReceiver(scope, receiver.text)
          : ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'app';
        if (isApp) found = { node, scope };
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(scope.source, visit);
    if (found) return found;
  }
  return null;
}

/**
 * Find the app's `defineApp({...})` registration.
 *
 * There is nothing to guess at: the shape is pinned, so the config argument of
 * the one `defineApp` call — reached from the entry module's default export —
 * *is* the protocol. Everything else is refused with a location rather than
 * resolved by heuristic.
 *
 * Returns null with no error when this app does not use `defineApp` at all;
 * callers must check `extractor.errors` to tell that apart from a rejection.
 */
function findDefineAppCall(
  ts: TsModule,
  scopes: ModuleScope[],
  extractor: Extractor,
): { args: TsExpression; scope: ModuleScope } | null {
  const calls: Array<{ call: import('typescript').CallExpression; scope: ModuleScope }> = [];
  for (const scope of scopes) {
    const visit = (node: TsNode): void => {
      if (isDefineAppCall(ts, node, scope)) {
        calls.push({ call: node as import('typescript').CallExpression, scope });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(scope.source, visit);
  }
  if (calls.length === 0) return null;

  // Two calls is two registrations. The runtime throws on the second one — a
  // window hosts exactly one app — so shipping a manifest built from either
  // would describe an app the iframe refuses to run.
  if (calls.length > 1) {
    extractor.error(
      calls[1].scope,
      calls[1].call,
      `found ${calls.length} \`defineApp({...})\` calls; a window hosts exactly one app, ` +
        `so keep a single \`export default defineApp({...})\``,
    );
    return null;
  }

  const site = calls[0];
  // The default export is the anchor: it is what the proposal pins, and it is
  // the only spelling under which registration timing is the SDK's to own.
  const entry = scopes[0];
  const exported = defaultExportExpression(ts, entry);
  const resolved = exported ? extractor.unwrap(exported, entry).node : null;
  if (resolved !== site.call) {
    extractor.error(
      site.scope,
      site.call,
      "`defineApp()`: its result must be the default export of the app's entry module " +
        '(`export default defineApp({...})` in src/main.ts)',
    );
    return null;
  }

  if (site.call.arguments.length !== 1 || ts.isSpreadElement(site.call.arguments[0])) {
    extractor.error(
      site.scope,
      site.call,
      '`defineApp()`: expected exactly one argument, an object literal describing the app',
    );
    return null;
  }

  return { args: site.call.arguments[0], scope: site.scope };
}

/**
 * Copy an optional JSON-object property (`params`/`returns`/`schema`) onto a
 * descriptor.
 *
 * A value that will not fold statically is *deferred* rather than rejected:
 * `z.object({...})` is a builder chain, not a constant, so a static evaluator can
 * only ever report it as unresolvable. Rather than teach this evaluator Zod's
 * API, the path is recorded and `fold-schemas.ts` reads the schema off the app it
 * runs. The refusal property is unchanged — the fold either produces the schema
 * or the build fails naming this same path. Deferral is sound because
 * `defineApp`'s config is reachable at runtime as the entry module's default
 * export, which is what makes reading a schema back out of the running app
 * possible at all.
 */
function assignObject(
  extractor: Extractor,
  target: Record<string, unknown>,
  key: string,
  source: Map<string, { value: TsNode; scope: ModuleScope }>,
  label: string,
): boolean {
  const entry = source.get(key);
  if (!entry) return true;
  const mark = extractor.errors.length;
  const value = extractor.evaluate(entry.value, entry.scope, `${label}.${key}`);
  if (value === undefined) {
    extractor.rollbackErrors(mark);
    extractor.pendingFolds.push(`${label}.${key}`);
    return true;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    extractor.error(entry.scope, entry.value, `\`${label}.${key}\`: expected an object`);
    return false;
  }
  target[key] = value;
  return true;
}

/**
 * Reject two commands reachable by the same name.
 *
 * At runtime the SDK builds one flat alias map and the last registration wins, so
 * a duplicate does not fail — it makes one command silently unreachable. The
 * manifest still advertises both, so the agent calls a name that answers with the
 * wrong handler. Names and aliases share the lookup, which is why a name
 * colliding with another command's alias is the same defect.
 */
function checkAliasCollisions(
  extractor: Extractor,
  entries: Array<{ key: string; value: TsNode; scope: ModuleScope }>,
  commands: Protocol['commands'],
): void {
  const owners = new Map<string, { command: string; kind: 'name' | 'alias' }>();
  const byKey = new Map(entries.map((e) => [e.key, e]));

  const claim = (spelling: string, command: string, kind: 'name' | 'alias'): void => {
    const held = owners.get(spelling);
    if (!held) {
      owners.set(spelling, { command, kind });
      return;
    }
    const site = byKey.get(command);
    if (!site) return;
    const taken =
      held.kind === 'name' ? `command \`${held.command}\`` : `an alias of \`${held.command}\``;
    const mine = kind === 'name' ? 'a command name' : `an alias of \`${command}\``;
    extractor.error(
      site.scope,
      site.value,
      `\`commands.${command}\`: \`${spelling}\` is already ${taken} and is also ${mine}; ` +
        `one name resolves to one command at runtime, so the other becomes unreachable`,
    );
  };

  for (const name of Object.keys(commands)) claim(name, name, 'name');
  for (const [name, descriptor] of Object.entries(commands)) {
    for (const alias of descriptor.aliases ?? []) claim(alias, name, 'alias');
  }
}

/** The property each `defineApp` descriptor carries its implementation under. */
const IMPL_KEYS = { state: 'get', commands: 'run' } as const;

/**
 * Turn a flattened `defineApp({...})` config into the manifest.
 *
 * Spreads, `const` refs, and identity wrappers resolve here, and anything
 * unresolvable is an error rather than an omission.
 */
function buildProtocol(
  ts: TsModule,
  extractor: Extractor,
  config: Array<{ key: string; value: TsNode; scope: ModuleScope }>,
): Protocol {
  const sections = new Map(config.map((e) => [e.key, e]));
  const protocol: Protocol = { state: {}, commands: {} };

  /** Resolve a top-level section (`state`/`commands`/`events`) to its entries. */
  const sectionEntries = (
    name: 'state' | 'commands' | 'events',
  ): Array<{ key: string; value: TsNode; scope: ModuleScope }> | null => {
    const section = sections.get(name);
    if (!section) return [];
    const { node, scope } = extractor.unwrap(section.value, section.scope);
    if (!ts.isObjectLiteralExpression(node)) {
      extractor.error(
        section.scope,
        section.value,
        `\`${name}\`: could not be resolved to an object literal ` +
          `(${extractor.describeNode(node)})`,
      );
      return null;
    }
    return extractor.flattenObject(node, scope, name);
  };

  /** Resolve one descriptor to its own property map. */
  const descriptorProps = (
    entry: { key: string; value: TsNode; scope: ModuleScope },
    label: string,
  ): Map<string, { value: TsNode; scope: ModuleScope }> | null => {
    const { node, scope } = extractor.unwrap(entry.value, entry.scope);
    if (!ts.isObjectLiteralExpression(node)) {
      extractor.error(
        entry.scope,
        entry.value,
        `\`${label}\`: descriptor could not be resolved to an object literal ` +
          `(${extractor.describeNode(node)})`,
      );
      return null;
    }
    const props = extractor.flattenObject(node, scope, label);
    if (props === null) return null;
    return new Map(props.map((p) => [p.key, { value: p.value, scope: p.scope }]));
  };

  /**
   * A manifest entry whose implementation is missing answers nothing at
   * runtime, so it is a command in name only.
   */
  const hasImpl = (
    props: Map<string, { value: TsNode; scope: ModuleScope }>,
    entry: { value: TsNode; scope: ModuleScope },
    label: string,
    kind: keyof typeof IMPL_KEYS,
  ): boolean => {
    const key = IMPL_KEYS[kind];
    if (props.has(key)) return true;
    extractor.error(
      entry.scope,
      entry.value,
      `\`${label}\`: missing \`${key}\`; an entry the app cannot ` +
        `${kind === 'state' ? 'read' : 'run'} is not a capability`,
    );
    return false;
  };

  /** Every descriptor needs a description — it is what the agent reads. */
  const readDescription = (
    props: Map<string, { value: TsNode; scope: ModuleScope }>,
    entry: { value: TsNode; scope: ModuleScope },
    label: string,
  ): string | null => {
    const prop = props.get('description');
    if (!prop) {
      extractor.error(
        entry.scope,
        entry.value,
        `\`${label}\`: missing \`description\`; an entry without one is invisible to agents`,
      );
      return null;
    }
    const value = extractor.evaluate(prop.value, prop.scope, `${label}.description`);
    if (value === undefined) return null;
    if (typeof value !== 'string') {
      extractor.error(prop.scope, prop.value, `\`${label}.description\`: expected a string`);
      return null;
    }
    return value;
  };

  // -- state ---------------------------------------------------------------
  const stateEntries = sectionEntries('state');
  if (stateEntries) {
    for (const entry of stateEntries) {
      if (entry.key === 'manifest') continue; // built-in, served by the SDK
      const label = `state.${entry.key}`;
      const props = descriptorProps(entry, label);
      if (!props) continue;
      if (!hasImpl(props, entry, label, 'state')) continue;
      const description = readDescription(props, entry, label);
      if (description === null) continue;
      const descriptor: Record<string, unknown> = { description };
      if (!assignObject(extractor, descriptor, 'schema', props, label)) continue;
      protocol.state[entry.key] = descriptor as { description: string; schema?: object };
    }
  }

  // -- commands ------------------------------------------------------------
  const commandEntries = sectionEntries('commands');
  if (commandEntries) {
    for (const entry of commandEntries) {
      const label = `commands.${entry.key}`;
      const props = descriptorProps(entry, label);
      if (!props) continue;
      if (!hasImpl(props, entry, label, 'commands')) continue;
      const description = readDescription(props, entry, label);
      if (description === null) continue;
      const descriptor: Record<string, unknown> = { description };

      const aliasProp = props.get('aliases');
      if (aliasProp) {
        const aliases = extractor.evaluate(aliasProp.value, aliasProp.scope, `${label}.aliases`);
        if (aliases === undefined) continue;
        if (!Array.isArray(aliases) || !aliases.every((a) => typeof a === 'string')) {
          extractor.error(
            aliasProp.scope,
            aliasProp.value,
            `\`${label}.aliases\`: expected an array of strings`,
          );
          continue;
        }
        descriptor.aliases = aliases;
      }

      // The replay policy has to reach the manifest, not just the runtime: the
      // server reads it to decide whether a remounted iframe gets this command
      // re-sent. A descriptor that says `replay: 'never'` while the manifest
      // says nothing is a command that double-applies on every remount.
      const replayProp = props.get('replay');
      if (replayProp) {
        const replay = extractor.evaluate(replayProp.value, replayProp.scope, `${label}.replay`);
        if (replay === undefined) continue;
        if (replay !== 'always' && replay !== 'never') {
          extractor.error(
            replayProp.scope,
            replayProp.value,
            `\`${label}.replay\`: expected 'always' or 'never'`,
          );
          continue;
        }
        descriptor.replay = replay;
      }

      if (!assignObject(extractor, descriptor, 'params', props, label)) continue;
      if (!assignObject(extractor, descriptor, 'returns', props, label)) continue;
      protocol.commands[entry.key] = descriptor as {
        description: string;
        aliases?: string[];
        params?: object;
        returns?: object;
      };
    }
    checkAliasCollisions(extractor, commandEntries, protocol.commands);
  }

  // -- keybindings ---------------------------------------------------------
  // Runs after commands so bindings can be checked against the declared names.
  // Entries are plain `combo: 'commandName'` strings, not descriptor objects,
  // so this resolves values directly instead of going through descriptorProps.
  const kbSection = sections.get('keybindings');
  if (kbSection) {
    const { node, scope } = extractor.unwrap(kbSection.value, kbSection.scope);
    if (!ts.isObjectLiteralExpression(node)) {
      extractor.error(
        kbSection.scope,
        kbSection.value,
        `\`keybindings\`: could not be resolved to an object literal ` +
          `(${extractor.describeNode(node)})`,
      );
    } else {
      const entries = extractor.flattenObject(node, scope, 'keybindings');
      if (entries) {
        const keybindings: Record<string, string> = {};
        const entryNodes = new Map<string, { value: TsNode; scope: ModuleScope }>();
        for (const entry of entries) {
          const label = `keybindings.${entry.key}`;
          const value = extractor.evaluate(entry.value, entry.scope, label);
          if (value === undefined) continue;
          if (typeof value !== 'string') {
            extractor.error(
              entry.scope,
              entry.value,
              `\`${label}\`: expected a command name string`,
            );
            continue;
          }
          keybindings[entry.key] = value;
          entryNodes.set(entry.key, { value: entry.value, scope: entry.scope });
        }
        // Semantic checks live in @yaar/shared so the fold path rejects identically.
        for (const { combo, issue } of listKeybindingIssues(
          keybindings,
          Object.keys(protocol.commands),
        )) {
          const at = entryNodes.get(combo);
          if (at) extractor.error(at.scope, at.value, `\`keybindings.${combo}\`: ${issue}`);
          delete keybindings[combo];
        }
        if (Object.keys(keybindings).length > 0) protocol.keybindings = keybindings;
      }
    }
  }

  // -- events --------------------------------------------------------------
  const eventEntries = sectionEntries('events');
  if (eventEntries && eventEntries.length > 0) {
    const events: NonNullable<Protocol['events']> = {};
    for (const entry of eventEntries) {
      const label = `events.${entry.key}`;
      const props = descriptorProps(entry, label);
      if (!props) continue;
      const description = readDescription(props, entry, label);
      if (description === null) continue;
      events[entry.key] = { description };
    }
    if (Object.keys(events).length > 0) protocol.events = events;
  }

  return protocol;
}

/** An extracted protocol, or null when nothing was declared. */
function finish(extractor: Extractor, protocol: Protocol | null): AstProtocolExtraction {
  const rest = { pendingFolds: extractor.pendingFolds };
  if (extractor.errors.length > 0) return { protocol: null, errors: extractor.errors, ...rest };
  if (!protocol) return { protocol: null, errors: [], ...rest };
  const empty =
    Object.keys(protocol.state).length === 0 &&
    Object.keys(protocol.commands).length === 0 &&
    !protocol.events &&
    !protocol.keybindings;
  return { protocol: empty ? null : protocol, errors: [], ...rest };
}

export interface ExtractOptions {
  /**
   * The app's `app.json` `appId`, when it is known. `defineApp`'s `id` must
   * equal it, since the id is what the runtime registers under and what every
   * agent-facing route keys on. Undefined skips the check — a bare sandbox has
   * no app.json to compare against, and refusing to build there would block
   * exactly the scratch compiles the sandbox exists for.
   */
  appId?: string;
}

/**
 * Extract the app protocol manifest starting from `entry`, following relative
 * imports. `readFile` must return null for paths that do not exist.
 *
 * One registration shape is recognized: `export default defineApp({...})`, whose
 * config object *is* the protocol. An app still calling the removed
 * `app.register({...})` is refused by name rather than reported as declaring
 * nothing.
 *
 * `protocol` is null only when no registration was found at all. When `errors`
 * is non-empty the caller must fail the build: a manifest that parsed around an
 * unresolvable descriptor is a manifest missing commands.
 */
export function extractProtocolFromModules(
  ts: TsModule,
  entry: string,
  readFile: ReadFile,
  options: ExtractOptions = {},
): AstProtocolExtraction {
  const extractor = new Extractor(ts, readFile);
  /** Every early exit carries the same shape as `finish()`. */
  const bail = (): AstProtocolExtraction => ({
    protocol: null,
    errors: extractor.errors,
    pendingFolds: extractor.pendingFolds,
  });

  const scopes = extractor.moduleGraph(entry);
  // Errors already recorded (an unparseable file) must survive these early
  // exits — a module that failed to parse is exactly the case where "no
  // registration found" is the wrong conclusion to report silently.
  if (scopes.length === 0) return bail();

  const legacy = findAppRegisterCall(ts, scopes);
  if (legacy) {
    extractor.error(legacy.scope, legacy.node, APP_REGISTER_REMOVED_MESSAGE);
    return bail();
  }

  const defineApp = findDefineAppCall(ts, scopes, extractor);
  if (extractor.errors.length > 0) return bail();
  if (!defineApp) return bail();

  return finish(extractor, extractDefineApp(ts, extractor, defineApp, options));
}

/** Read the protocol out of a located `defineApp({...})` config. */
function extractDefineApp(
  ts: TsModule,
  extractor: Extractor,
  site: { args: TsExpression; scope: ModuleScope },
  options: ExtractOptions,
): Protocol | null {
  const { node: configNode, scope: configScope } = extractor.unwrap(site.args, site.scope);
  if (!ts.isObjectLiteralExpression(configNode)) {
    extractor.error(
      site.scope,
      site.args,
      `\`defineApp()\`: argument could not be resolved to an object literal ` +
        `(${extractor.describeNode(configNode)})`,
    );
    return null;
  }

  const config = extractor.flattenObject(configNode, configScope, 'defineApp');
  if (config === null) return null;

  checkAppId(extractor, config, site, options.appId);

  return buildProtocol(ts, extractor, config);
}

/**
 * `defineApp`'s `id` must be the app's own id.
 *
 * It is what the runtime registers under, what `protocol.json` is filed against,
 * and what every agent-facing route keys on. A mismatch does not fail anything
 * loudly — it produces a window whose manifest is filed under a name nothing
 * else uses.
 */
function checkAppId(
  extractor: Extractor,
  config: Array<{ key: string; value: TsNode; scope: ModuleScope }>,
  site: { args: TsExpression; scope: ModuleScope },
  expected: string | undefined,
): void {
  const entry = config.find((e) => e.key === 'id');
  if (!entry) {
    extractor.error(
      site.scope,
      site.args,
      "`defineApp()`: missing `id`; it must equal the `appId` in this app's app.json",
    );
    return;
  }
  const id = extractor.evaluate(entry.value, entry.scope, 'defineApp.id');
  if (id === undefined) return;
  if (typeof id !== 'string' || id === '') {
    extractor.error(entry.scope, entry.value, '`defineApp.id`: expected a non-empty string');
    return;
  }
  if (expected !== undefined && id !== expected) {
    extractor.error(
      entry.scope,
      entry.value,
      `\`defineApp.id\`: declared \`${id}\` but this app's app.json says \`${expected}\`; ` +
        `the id is what the app registers under, so the two must agree`,
    );
  }
}
