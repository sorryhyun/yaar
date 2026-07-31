/**
 * An action table that owns its own JSON-Schema enum.
 *
 * Every action-dispatching handler declared the same list twice: once as an
 * `enum` in `invokeSchema` (what the model is told it may call) and once as the
 * labels of a switch (what actually runs). Nothing tied the two together, so
 * they drifted silently and in both directions — `handlers/apps.ts` advertises a
 * `db` action (`update`) its collection switch cannot reach, and dispatches an
 * app action (`grep`) it never declared. The failure is quiet either way: an
 * undeclared action is invisible to the model, and an unimplemented one is
 * offered and then refused as "unknown".
 *
 * So the table is the source and the enum is derived from its keys. Adding a case
 * declares it; deleting a case undeclares it. They cannot disagree.
 *
 * This is deliberately NOT a universal dispatcher. Several handlers key on
 * *(URI shape, action)* rather than the action alone, and their cases need
 * incompatible context (a window id, a pool, an app id + path). Those stay as
 * they are; this only removes the hand-copied list. Each entry closes over
 * whatever context it needs, which is why the value is a thunk rather than a
 * uniform `(payload) => …` signature.
 */

import type { VerbResult } from './uri-registry.js';

/** A JSON-Schema fragment for a string field constrained to the table's keys. */
export interface ActionEnumSchema {
  type: 'string';
  enum: string[];
  description?: string;
}

export interface ActionTable<Ctx> {
  /** The declared action names, in declaration order. */
  names: string[];
  /** Drop-in `invokeSchema.properties.action`. Derived from `names`. */
  schema: ActionEnumSchema;
  /**
   * Action name → one-line description, for the entries that gave one.
   *
   * Same reason the enum is derived: `describe` advertised an `invokeActions` map
   * written a third time, next to the schema enum and the switch, and no two of the
   * three agreed. A description that comes off the table cannot name an action that
   * has no case.
   */
  docs: Record<string, string>;
  /** True if `action` is in the table. */
  has(action: string): boolean;
  /**
   * Run `action`, or return the standard refusal naming what is actually available.
   * The refusal lists `names`, so it cannot advertise an action that has no case.
   */
  dispatch(action: string, ctx: Ctx): Promise<VerbResult>;
}

export type ActionHandler<Ctx> = (ctx: Ctx) => VerbResult | Promise<VerbResult>;

/**
 * A table entry: the code alone, or the code with the one-line description a caller
 * of `describe` should be shown. Both spellings are accepted so an existing table
 * stays as it is until its actions are worth documenting.
 */
export type ActionEntry<Ctx> =
  | ActionHandler<Ctx>
  | { description: string; run: ActionHandler<Ctx> };

function runnerOf<Ctx>(entry: ActionEntry<Ctx>): ActionHandler<Ctx> {
  return typeof entry === 'function' ? entry : entry.run;
}

/**
 * @param actions  Action name → the code that runs it (optionally with its description).
 * @param opts.describe  Text appended to the derived schema's `description`.
 * @param opts.unknown  Overrides the refusal. Defaults to naming the available actions.
 */
export function defineActions<Ctx>(
  actions: Record<string, ActionEntry<Ctx>>,
  opts: {
    describe?: string;
    unknown?: (action: string, names: string[]) => VerbResult;
  } = {},
): ActionTable<Ctx> {
  const names = Object.keys(actions);
  const docs: Record<string, string> = {};
  for (const [name, entry] of Object.entries(actions)) {
    if (typeof entry !== 'function') docs[name] = entry.description;
  }

  return {
    names,
    schema: {
      type: 'string',
      enum: names,
      ...(opts.describe ? { description: opts.describe } : {}),
    },
    docs,
    has: (action) => Object.hasOwn(actions, action),
    async dispatch(action, ctx) {
      const entry = Object.hasOwn(actions, action) ? actions[action] : undefined;
      if (!entry) {
        return opts.unknown ? opts.unknown(action, names) : unknownAction(action, names);
      }
      return runnerOf(entry)(ctx);
    },
  };
}

/** The default refusal: says what was asked for, then what exists. */
function unknownAction(action: string, names: string[]): VerbResult {
  return {
    content: [
      { type: 'text', text: `Unknown action "${action}". Supported: ${names.join(', ')}.` },
    ],
    isError: true,
  };
}
