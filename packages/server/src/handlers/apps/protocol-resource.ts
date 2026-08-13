/**
 * `yaar://apps/{appId}/protocol[/{state|commands}[/{key}]]` — the installed app's manual,
 * addressable at its own granularity.
 *
 * Reached only through the composite `yaar://apps/*` handler in `register.ts` (the
 * registry has no middle wildcard). Each entry point returns `null` for a non-protocol
 * URI so the composite can fall through to the app itself.
 *
 * ## Why this resource exists
 *
 * `describe('yaar://apps/{id}')` used to answer with `dist/protocol.json` verbatim, which
 * made one door responsible for two questions of wildly different size: "what is this app"
 * (identity + SKILL.md, a fixed ~10 KB) and "what exactly does every one of its 52 commands
 * accept" (41.8 KB for studio-3d, and unbounded in the app's command count). The sum
 * crossed the Claude CLI's large-output threshold, which replaces the result with a path on
 * disk — and a monitor agent holds the five `yaar:// `verbs and no filesystem tools, so the
 * pointer is a dead end for every YAAR principal. The cliff itself — where it actually sits,
 * and how a server raises it — is named and moved in `mcp/result-size.ts`.
 *
 * Splitting the protocol onto its own URI is not just a size fix, though; it is what lets
 * the three verbs mean here what they mean everywhere else, and the granularity falls out
 * of that rather than out of a byte budget:
 *
 * | verb | on `…/protocol` | answers |
 * |---|---|---|
 * | `describe` | the resource | what this doc is and how to slice it — never grows |
 * | `list` | the index | signature + opening sentence per command (~8 KB / 52 commands) |
 * | `read` | the manifest | `dist/protocol.json` verbatim, opt-in, the only large answer |
 * | `read` | `…/commands/{key}` | one command, self-contained, brace-batchable |
 *
 * So an agent that wants everything asks for everything and knows it did; an agent that is
 * *finding* the right command pays for an index. Nothing is truncated behind a caller's
 * back, and no threshold in an unpinned CLI decides which half survives.
 *
 * ## Installed, not running
 *
 * This is the manifest **as compiled** — `dist/protocol.json`, read off disk by
 * `discovery.ts`. A running app registers its protocol live and may not agree (a devtools
 * preview is the routine case), and that instance's manual is the window door's job:
 * `describe('yaar://windows/{id}')` and `describe('yaar://windows/{id}/commands/{key}')`.
 * Reading one and driving the other is the mistake this note exists to prevent.
 */

import type { VerbResult } from '../uri-registry.js';
import { okJson, okLinks, error, prependNote } from '../utils.js';
import { listApps } from '../../features/apps/discovery.js';
import { parseAppProtocolPath } from './paths.js';
import {
  renderSignature,
  renderInvokeExample,
  reservedKeyNote,
} from '../../lib/command-signature.js';
import { defsOf, selfContained } from '../../lib/schema-refs.js';
import { commandLinkDescription, firstSentence, descriptionOf } from '../../lib/protocol-index.js';

/** The two sections a protocol has. Anything else under `/protocol/` is a typo. */
const SECTIONS = ['state', 'commands'] as const;
type Section = (typeof SECTIONS)[number];

type Protocol = {
  state?: Record<string, unknown>;
  commands?: Record<string, unknown>;
  $defs?: Record<string, unknown>;
};

/** A parsed, validated protocol address, or the refusal that explains why it isn't one. */
type Target =
  | { ok: true; appId: string; section?: Section; key?: string }
  | { ok: false; result: VerbResult };

function parseTarget(uri: string): Target | null {
  const parsed = parseAppProtocolPath(uri);
  if (!parsed) return null;

  const { appId, rest } = parsed;
  if (!rest) return { ok: true, appId };

  const [section, ...tail] = rest.split('/');
  if (!(SECTIONS as readonly string[]).includes(section)) {
    return {
      ok: false,
      result: error(
        `"${section}" is not a section of a protocol. A protocol has "state" and "commands": ` +
          `yaar://apps/${appId}/protocol/commands/{name}.`,
      ),
    };
  }
  if (tail.length > 1) {
    return {
      ok: false,
      result: error(
        `"${uri}" is too deep. One key per address: yaar://apps/${appId}/protocol/${section}/{name}.`,
      ),
    };
  }
  return { ok: true, appId, section: section as Section, key: tail[0] || undefined };
}

/** Either the compiled protocol, or the refusal explaining why there isn't one. */
type Loaded = { protocol: Protocol } | ReturnType<typeof error>;

function isLoaded(value: Loaded): value is { protocol: Protocol } {
  return 'protocol' in value;
}

/** The installed app's compiled protocol, or the refusal naming what is missing. */
async function loadProtocol(appId: string): Promise<Loaded> {
  const apps = await listApps();
  const app = apps.find((a) => a.id === appId);
  if (!app) return error(`App "${appId}" not found.`);
  if (!app.protocol) {
    return error(
      `App "${appId}" ships no protocol.json — it exposes no state keys and no commands. ` +
        `describe("yaar://apps/${appId}") for what it is.`,
    );
  }
  return { protocol: app.protocol as Protocol };
}

/** The section's table, and the noun to use when a key is missing from it. */
function tableOf(protocol: Protocol, section: Section): Record<string, unknown> {
  return (section === 'state' ? protocol.state : protocol.commands) ?? {};
}

/**
 * `describe` — what this document is, not what it says.
 *
 * Deliberately independent of the app's size: counts, not content. It is the one answer
 * here that can never be the thing an agent cannot receive, which is the point of having
 * it be the door a lost caller lands on.
 */
export async function describeAppProtocol(uri: string): Promise<VerbResult | null> {
  const target = parseTarget(uri);
  if (!target) return null;
  if (!target.ok) return target.result;

  const loaded = await loadProtocol(target.appId);
  if (!isLoaded(loaded)) return loaded;
  const { protocol } = loaded;
  const base = `yaar://apps/${target.appId}/protocol`;

  if (target.section && target.key) {
    const entry = tableOf(protocol, target.section)[target.key];
    if (entry === undefined) {
      return error(`"${target.key}" is not a ${target.section} key of "${target.appId}".`);
    }
    return okJson({
      uri,
      description: descriptionOf(entry),
      ...(target.section === 'commands'
        ? { signature: renderSignature(target.key, entry, defsOf(protocol)) }
        : {}),
      read: `read("${uri}") for the full entry, schema included.`,
    });
  }

  return okJson({
    uri: base,
    appId: target.appId,
    what: `The compiled protocol of the installed app "${target.appId}" — every state key and command it declares, as ${'`dist/protocol.json`'}. This is the app as built, not a running instance: for the live manifest of an open window use describe("yaar://windows/{windowId}").`,
    stateKeys: Object.keys(protocol.state ?? {}).length,
    commands: Object.keys(protocol.commands ?? {}).length,
    sharedSchemas: Object.keys(protocol.$defs ?? {}).length,
    bytes: JSON.stringify(protocol).length,
    verbs: ['describe', 'read', 'list'],
    doors: {
      index: `list("${base}") — one row per command: its signature and its opening sentence. Start here.`,
      full: `read("${base}") — the whole manifest verbatim, every schema and every word. Large.`,
      one: `read("${base}/commands/{name}") — one command, self-contained. Brace-batch related ones: ${base}/commands/{a,b,c}`,
      state: `read("${base}/state/{key}") — one state key.`,
    },
    note:
      'Commands are documented here but not callable here — a command needs a running window. ' +
      'Open the app, then invoke("yaar://windows/{windowId}/commands/{name}", { ... }).',
  });
}

/** `read` — the manifest, a section of it, or one entry, self-contained. */
export async function readAppProtocol(uri: string): Promise<VerbResult | null> {
  const target = parseTarget(uri);
  if (!target) return null;
  if (!target.ok) return target.result;

  const loaded = await loadProtocol(target.appId);
  if (!isLoaded(loaded)) return loaded;
  const { protocol } = loaded;
  const defs = defsOf(protocol);
  const base = `yaar://apps/${target.appId}/protocol`;

  // The whole thing. The one large answer this resource gives, and the caller asked for it.
  if (!target.section) {
    return prependNote(
      okJson({ uri: base, appId: target.appId, ...protocol }),
      `the full manifest — list("${base}") is the index if you only need to find a command`,
    );
  }

  const table = tableOf(protocol, target.section);

  // A whole section, still whole: `commands` without a key is most of the manifest, and
  // saying so is better than quietly handing back an index the caller did not ask for.
  if (!target.key) {
    return okJson({
      uri,
      appId: target.appId,
      ...(defs ? { $defs: defs } : {}),
      [target.section]: table,
    });
  }

  const entry = table[target.key];
  if (entry === undefined) {
    const names = Object.keys(table);
    return error(
      `"${target.key}" is not a ${target.section} key of "${target.appId}". ` +
        (names.length
          ? `Declared: ${names.slice(0, 40).join(', ')}${names.length > 40 ? `, … (${names.length} total)` : ''}.`
          : `It declares no ${target.section}.`),
    );
  }

  if (target.section === 'state') {
    const schema = (entry as { schema?: unknown }).schema;
    return okJson({
      uri,
      key: target.key,
      description: descriptionOf(entry),
      // A state key is read from a *window*, so the follow-up door is named rather than
      // implied — this URI documents the key and cannot produce its value.
      ...(schema !== undefined ? { schema: selfContained(schema, defs) } : {}),
      read: `read("yaar://windows/{windowId}/state/${target.key}") for its current value.`,
    });
  }

  const descriptor = entry as CommandDescriptor;
  return okJson({
    uri,
    ...commandDocument(target.key, descriptor, defs, {
      // Rendered against the *window* door, because that is where a command runs. Naming
      // the URI this document lives at would render an example that is refused.
      call: renderInvokeExample(
        `yaar://windows/{windowId}/commands/${target.key}`,
        descriptor,
        defs,
      ),
    }),
  });
}

/** The fields a command descriptor carries. Everything is optional in a hand-written one. */
export type CommandDescriptor = { description?: string; params?: unknown; returns?: unknown };

/**
 * One command as a document that stands on its own.
 *
 * The schema has to carry the `$defs` it points at (`selfContained`): this is a slice of
 * the manifest, and a slice with a dangling `#/$defs/…` is corrupt — which matters most
 * here, because this is precisely the door an agent reaches for when a signature left it
 * unsure. Inlining the defs instead would re-create the duplication the compiler's hoist
 * removed and has no answer at all for a recursive schema.
 *
 * `call` is supplied rather than rendered because the two callers speak different
 * vocabularies for the same act: a verbs caller invokes a window sub-path URI, an app
 * agent calls `command(name, params)`. Everything *else* about the answer is identical,
 * and that is what this shares.
 */
export function commandDocument(
  name: string,
  descriptor: CommandDescriptor,
  defs: ReturnType<typeof defsOf>,
  rendered: { call: string },
): Record<string, unknown> {
  // The collision note the window-side describe already carries: a command declaring
  // `action`/`params`/`timeoutMs` as a param of its own keeps it, and the reader has to be
  // told, or the sub-path spelling looks like it claims the name.
  const note = reservedKeyNote(descriptor, defs);
  return {
    name,
    signature: renderSignature(name, descriptor, defs),
    description: descriptionOf(descriptor),
    ...(note ? { note } : {}),
    ...(descriptor.params !== undefined ? { params: selfContained(descriptor.params, defs) } : {}),
    ...(descriptor.returns !== undefined
      ? { returns: selfContained(descriptor.returns, defs) }
      : {}),
    call: rendered.call,
  };
}

/**
 * Look one command up in an installed app's compiled protocol.
 *
 * Shared with the app agent's `describe` tool, which reaches the same document through
 * its own vocabulary. The not-found branch lists the declared names rather than only
 * refusing: a wrong command name is nearly always a near-miss, and the list is what turns
 * a dead end into the next call.
 */
export async function findProtocolCommand(
  appId: string,
  name: string,
): Promise<
  { descriptor: CommandDescriptor; defs: ReturnType<typeof defsOf> } | ReturnType<typeof error>
> {
  const loaded = await loadProtocol(appId);
  if (!isLoaded(loaded)) return loaded;
  const commands = loaded.protocol.commands ?? {};
  const entry = commands[name];
  if (entry === undefined) {
    const names = Object.keys(commands);
    return error(
      `"${name}" is not a command of "${appId}". ` +
        (names.length
          ? `Declared: ${names.slice(0, 40).join(', ')}${names.length > 40 ? `, … (${names.length} total)` : ''}.`
          : 'It declares no commands.'),
    );
  }
  return { descriptor: entry as CommandDescriptor, defs: defsOf(loaded.protocol) };
}

/** `list` — the index: enough to pick a command from, not enough to be the manual. */
export async function listAppProtocol(uri: string): Promise<VerbResult | null> {
  const target = parseTarget(uri);
  if (!target) return null;
  if (!target.ok) return target.result;
  if (target.key) {
    return error(
      `"${uri}" is one entry, not a collection. Use read("${uri}") for it, or ` +
        `list("yaar://apps/${target.appId}/protocol") for the index.`,
    );
  }

  const loaded = await loadProtocol(target.appId);
  if (!isLoaded(loaded)) return loaded;
  const { protocol } = loaded;
  const defs = defsOf(protocol);
  const base = `yaar://apps/${target.appId}/protocol`;

  const links: Array<{ uri: string; name: string; description: string }> = [];
  if (target.section !== 'commands') {
    for (const [key, entry] of Object.entries(protocol.state ?? {})) {
      links.push({
        uri: `${base}/state/${key}`,
        name: `state/${key}`,
        description: firstSentence(descriptionOf(entry)),
      });
    }
  }
  if (target.section !== 'state') {
    for (const [key, entry] of Object.entries(protocol.commands ?? {})) {
      // The signature rides in `description` rather than in a field of its own because
      // that is the part of a `resource_link` a model is certain to read — the same
      // reasoning as the window list door, which shares `commandLinkDescription`.
      links.push({
        uri: `${base}/commands/${key}`,
        name: `commands/${key}`,
        description: commandLinkDescription(key, entry, defs),
      });
    }
  }

  return prependNote(
    okLinks(links),
    `the index — descriptions are summarized to their first sentence; read("${base}/commands/{name}") ` +
      'for one in full, or brace-batch: {a,b,c}',
  );
}

/**
 * A protocol is documentation. It is read, never written and never run — the refusal names
 * the door that *does* run a command rather than just saying no, because "invoke a command
 * on the installed app" is a reasonable thing to try and the right answer is one URI away.
 */
export function rejectProtocolMutation(uri: string, verb: 'invoke' | 'delete'): VerbResult | null {
  const parsed = parseAppProtocolPath(uri);
  if (!parsed) return null;
  return error(
    verb === 'invoke'
      ? `Cannot invoke "${uri}" — a protocol is documentation, and a command needs a running ` +
          `window to act on. Open the app, then ` +
          `invoke("yaar://windows/{windowId}/commands/{name}", { ... }).`
      : `Cannot delete "${uri}" — a protocol is a build artifact of the installed app. ` +
          `delete("yaar://apps/${parsed.appId}") uninstalls the app itself.`,
  );
}
