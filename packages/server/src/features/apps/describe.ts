/**
 * What one app looks like to another agent — the facts behind
 * `describe('yaar://apps/{appId}')`.
 *
 * `describe` is the manual. It answers with the app's identity, its hand-written
 * `agent/SKILL.md` when it ships one, and a **table of contents** for its protocol: the
 * names of every state key and command, and the URI that serves each in full. It is not
 * the app's current state — that is `read`, which returns the effective manifest
 * (`handlers/apps/app-resource.ts`).
 *
 * ## Why the protocol is named here rather than included
 *
 * It used to be included — `dist/protocol.json` verbatim — and that made one answer
 * responsible for two questions whose sizes differ by an order of magnitude. Identity plus
 * SKILL.md is a fixed ~10 KB; the manifest is 41.8 KB for a 52-command app and grows with
 * every command added. Their sum crossed the threshold at which the Claude CLI stops
 * delivering a tool result inline and substitutes a path on disk — and a monitor agent
 * holds the five `yaar://` verbs and no filesystem tools, so that path is a dead end for
 * every YAAR principal. The failure is total, not gradual: past the line the answer is
 * *gone*, not merely expensive.
 *
 * The fix is not a byte budget that silently truncates. It is that the protocol is its own
 * resource (`yaar://apps/{id}/protocol`, `handlers/apps/protocol-resource.ts`) where the
 * three verbs mean what they mean everywhere else — `list` is the index, `read` is the
 * manifest, `read` on one command is one command. Describe names those doors and carries
 * the command *names*, which is what makes the follow-up a targeted read rather than a
 * search: ~15 bytes per command, so this answer's size stays governed by how much the
 * author wrote in SKILL.md rather than by how many commands the app has.
 *
 * Returning the protocol whole carried no drift risk, which is what killed the *previous*
 * SKILL.md, and that is still true of the resource it moved to: the file is a build
 * artifact. `compile.ts` writes it from AST extraction of the source, `fold-schemas.ts`
 * inlines the Zod param schemas into it, `dedupe-schemas.ts` hoists what it repeats, and
 * `deploy.ts` re-derives and diffs it on every deploy. It cannot disagree with the code the
 * way a hand-written restatement can — and `agent/SKILL.md` is scoped to exactly what a
 * generated protocol cannot say: workflows, ordering constraints, when *not* to use the app.
 */

import { listApps, loadAppSkill } from './discovery.js';
import { defsOf } from '../../lib/schema-refs.js';
import { buildProtocolIndex } from '../../lib/protocol-index.js';

/**
 * How much of the protocol a describe carries inline.
 *
 * - `'names'` — state keys and command names only. The default, and what the verbs door
 *   uses: its caller holds `read`/`list`, so the cheapest useful thing is a table of
 *   contents plus the URIs that serve the rest.
 * - `'index'` — the full index rows (signature + opening sentence per command). For the
 *   app agent's `describe` **tool**, whose caller holds four scoped tools and no verbs at
 *   all: a pointer it cannot follow is the very dead end this split exists to remove, so
 *   that door pays the ~8 KB and hands over something callable.
 */
export type ProtocolDetail = 'names' | 'index';

export interface DescribeAppOptions {
  /** Default `'names'`. See `ProtocolDetail`. */
  protocol?: ProtocolDetail;
}

/**
 * Build the app-facts half of the describe payload. Returns null if the app is not
 * installed — the caller turns that into the error, since it owns the URI.
 *
 * Deliberately does *not* carry `verbs` or `invokeActions`: those describe what the
 * handler does, not what the app is, and the handler derives them from the table that
 * dispatches them (`appActions`). Three hand-written copies of that list is how they
 * came to disagree in the first place.
 */
export async function describeApp(
  appId: string,
  options: DescribeAppOptions = {},
): Promise<Record<string, unknown> | null> {
  const apps = await listApps();
  const app = apps.find((a) => a.id === appId);
  if (!app) return null;

  const skill = await loadAppSkill(appId);

  return {
    name: app.name,
    ...(app.description ? { description: app.description } : {}),
    ...(app.icon ? { icon: app.icon } : {}),
    // The protocol as compiled, minus persona-audience commands — those are the
    // sub-agent's half of the protocol and are described to it in its own voice at
    // spawn, so an operator reading them reads the wrong script (`persona-commands.ts`).
    ...(app.protocol ? protocolSection(appId, app.protocol, options.protocol ?? 'names') : {}),
    ...(skill ? { skill } : {}),
    ...(app.permissions?.length ? { permissions: app.permissions } : {}),
  };
}

/** The manifest fields this file reads. `discovery.ts` owns the real type. */
type CompiledProtocol = {
  state?: Record<string, unknown>;
  commands?: Record<string, unknown>;
  $defs?: Record<string, unknown>;
};

/**
 * The `protocol` block of a describe payload: a table of contents, never the table.
 *
 * The key stayed `protocol` and its *shape* changed — it is now an object with `commands`
 * and `stateKeys` arrays rather than the manifest's `commands`/`state` tables. That is a
 * deliberate break rather than a new key beside the old one: leaving `protocol` meaning
 * "the manifest" in some answers and "the index" in others is exactly the ambiguity that
 * made `read` and `describe` interchangeable for apps in the first place. Callers that
 * want the tables now say so, at a URI that says so.
 */
function protocolSection(
  appId: string,
  protocol: CompiledProtocol,
  detail: ProtocolDetail,
): Record<string, unknown> {
  const base = `yaar://apps/${appId}/protocol`;
  const commandNames = Object.keys(protocol.commands ?? {});
  const stateNames = Object.keys(protocol.state ?? {});
  const index = detail === 'index' ? buildProtocolIndex(protocol, defsOf(protocol)) : null;

  return {
    protocol: {
      uri: base,
      stateKeys: index ? index.state : stateNames,
      commands: index ? index.commands : commandNames,
      // Named as instructions rather than offered as options: an agent handed four doors
      // it has just learned about will pick `read` and pay for the whole manifest, which
      // is the cost this split exists to make optional. Each door's vocabulary is its
      // own — a verbs caller has `list`/`read`, an app agent has neither and reaches one
      // command through its own `describe` tool.
      ...(detail === 'names'
        ? {
            index: `list("${base}") — every command's signature and opening sentence.`,
            one: `read("${base}/commands/{name}") — one command in full, schema included. Brace-batch related ones: ${base}/commands/{a,b,c}`,
            full: `read("${base}") — the whole manifest verbatim. Large; prefer the two above.`,
            run:
              'Commands are documented here but run on a running window: ' +
              'invoke("yaar://windows/{windowId}/commands/{name}", { ... }).',
          }
        : {
            one:
              `describe({ command: "{name}"${appId ? `, appId: "${appId}"` : ''} }) — ` +
              'one command in full, schema included.',
            run: `command("{name}", { ... })${appId ? ` with appId: "${appId}"` : ''} runs one.`,
          }),
    },
  };
}
