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
 * | `read` | `…/commands/{group}` | every command of one group, each self-contained |
 *
 * ## Groups
 *
 * A command key may be `group/name` (`COMMAND_GROUP_SEPARATOR` in `@yaar/shared`). For
 * an app that uses them, `list` answers with the groups — one link per chapter, naming
 * its commands — and `read` of a group is the chapter: every command in it with its
 * schema and full description. That is the whole detail tier for a grouped app; there
 * is no third "now describe the one you picked" step to forget. The group is only a
 * table of contents: the key stays the command's full name, so
 * `…/commands/files/edit` is the command `files/edit`, never "edit inside files".
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

import { okJson, okLinks, error, prependNote, type VerbResult } from '../../lib/verb-result.js';
import { listApps } from '../../features/apps/discovery.js';
import { parseAppProtocolPath } from './paths.js';
import {
  renderSignature,
  renderInvokeExample,
  reservedKeyNote,
} from '../../lib/command-signature.js';
import { defsOf, selfContained } from '../../lib/schema-refs.js';
import {
  commandLinkDescription,
  commandsInGroup,
  firstSentence,
  descriptionOf,
} from '../../lib/protocol-index.js';
import { groupCommandKeys } from '@yaar/shared';

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
  { ok: true; appId: string; section?: Section; key?: string } | { ok: false; result: VerbResult };

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
  // `commands/{group}/{name}` is one key, `group/name`; a deeper path names nothing.
  if (tail.length > (section === 'commands' ? 2 : 1)) {
    return {
      ok: false,
      result: error(
        `"${uri}" is too deep. One key per address: yaar://apps/${appId}/protocol/${section}/{name}` +
          (section === 'commands' ? ` or …/commands/{group}/{name}.` : '.'),
      ),
    };
  }
  return { ok: true, appId, section: section as Section, key: tail.join('/') || undefined };
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
    const members =
      entry === undefined && target.section === 'commands'
        ? commandsInGroup(protocol.commands, target.key)
        : [];
    if (members.length > 0) {
      return okJson({
        uri,
        group: target.key,
        commands: members,
        read: `read("${uri}") — every command of the group in full, schemas included.`,
      });
    }
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

  const grouped = groupCommandKeys(Object.keys(protocol.commands ?? {})).groups.size > 0;
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
      ...(grouped
        ? {
            group: `read("${base}/commands/{group}") — every command of one group in full. Commands are grouped "group/name"; list names the groups.`,
          }
        : {}),
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
  if (entry === undefined && target.section === 'commands') {
    const doc = groupDocument(protocol, target.key, (name, descriptor, groupDefs) =>
      renderInvokeExample(`yaar://windows/{windowId}/commands/${name}`, descriptor, groupDefs),
    );
    if (doc) return okJson({ uri, ...doc });
  }
  if (entry === undefined) {
    return error(
      `"${target.key}" is not a ${target.section} key of "${target.appId}". ${declaredNames(table, target.section)}`,
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
  rendered: { call: string; inGroup?: boolean },
): Record<string, unknown> {
  // The collision note the window-side describe already carries: a command declaring
  // `action`/`params`/`timeoutMs` as a param of its own keeps it, and the reader has to be
  // told, or the sub-path spelling looks like it claims the name. A group read states it
  // once for the chapter instead (`groupDocument`), so a member document carries none.
  const note = rendered.inGroup ? null : reservedKeyNote([[name, descriptor]], defs);
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
    return error(
      `"${name}" is not a command of "${appId}". ${declaredNames(commands, 'commands')}`,
    );
  }
  return { descriptor: entry as CommandDescriptor, defs: defsOf(loaded.protocol) };
}

/**
 * One group of an installed app's compiled protocol, in full — the app agent's
 * `describe({ group })`. `null` when the app loads but declares no such group, so the
 * caller can try the name as a command before refusing.
 */
export async function findProtocolGroup(
  appId: string,
  group: string,
  renderCall: (
    name: string,
    descriptor: CommandDescriptor,
    defs: ReturnType<typeof defsOf>,
  ) => string,
): Promise<Record<string, unknown> | ReturnType<typeof error> | null> {
  const loaded = await loadProtocol(appId);
  if (!isLoaded(loaded)) return loaded;
  return groupDocument(loaded.protocol, group, renderCall);
}

/**
 * Every command of one group as a document — `null` when `group` names no group, so
 * the caller falls through to its own not-found answer.
 *
 * Each command is the same `commandDocument` a single read serves, self-contained, so a
 * chapter is exactly its commands read one by one and nothing a reader learns from it
 * differs from what the per-command door would have said — with one exception: the
 * reserved-key note is hoisted to the chapter and names its colliding commands, because
 * the same sentence on every member is the repetition it exists to avoid. `call` is
 * rendered per caller for the reason `commandDocument` takes it as an argument.
 */
export function groupDocument(
  protocol: { commands?: Record<string, unknown>; $defs?: Record<string, unknown> },
  group: string,
  renderCall: (
    name: string,
    descriptor: CommandDescriptor,
    defs: ReturnType<typeof defsOf>,
  ) => string,
): Record<string, unknown> | null {
  const members = commandsInGroup(protocol.commands, group);
  if (members.length === 0) return null;
  const defs = defsOf(protocol);
  const note = reservedKeyNote(
    members.map((name) => [name, protocol.commands![name]] as const),
    defs,
  );
  return {
    group,
    ...(note ? { note } : {}),
    commands: members.map((name) => {
      const descriptor = protocol.commands![name] as CommandDescriptor;
      return commandDocument(name, descriptor, defs, {
        call: renderCall(name, descriptor, defs),
        inGroup: true,
      });
    }),
  };
}

/**
 * The "Declared: …" tail of a not-found answer. A grouped app is listed by its groups —
 * `files/{edit, read}` rather than every key spelled out — which is both shorter and
 * shows the miss most likely once keys carry a group (a bare `edit`) its full name.
 */
function declaredNames(table: Record<string, unknown>, noun: string): string {
  const names = Object.keys(table);
  if (names.length === 0) return `It declares no ${noun}.`;
  const { groups, ungrouped } = groupCommandKeys(names);
  if (groups.size === 0) {
    return `Declared: ${names.slice(0, 40).join(', ')}${names.length > 40 ? `, … (${names.length} total)` : ''}.`;
  }
  const parts = [
    ...ungrouped,
    ...[...groups].map(
      ([group, keys]) => `${group}/{${keys.map((k) => k.slice(group.length + 1)).join(', ')}}`,
    ),
  ];
  return `Declared: ${parts.join('; ')}. A command's name includes its group: "group/name".`;
}

/** `list` — the index: enough to pick a command from, not enough to be the manual. */
export async function listAppProtocol(uri: string): Promise<VerbResult | null> {
  const target = parseTarget(uri);
  if (!target) return null;
  if (!target.ok) return target.result;
  const loaded = await loadProtocol(target.appId);
  if (!isLoaded(loaded)) return loaded;
  const { protocol } = loaded;
  const defs = defsOf(protocol);
  const base = `yaar://apps/${target.appId}/protocol`;

  // A group is a collection: its commands, as index rows.
  const members =
    target.key && target.section === 'commands'
      ? commandsInGroup(protocol.commands, target.key)
      : [];
  if (target.key && members.length === 0) {
    return error(
      `"${uri}" is one entry, not a collection. Use read("${uri}") for it, or ` +
        `list("yaar://apps/${target.appId}/protocol") for the index.`,
    );
  }
  if (members.length > 0) {
    return prependNote(
      okLinks(
        members.map((key) => ({
          uri: `${base}/commands/${key}`,
          name: `commands/${key}`,
          description: commandLinkDescription(key, protocol.commands![key], defs),
        })),
      ),
      `group "${target.key}" — read("${uri}") gives every one of them in full`,
    );
  }

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
  const commands = protocol.commands ?? {};
  const { groups, ungrouped } = groupCommandKeys(Object.keys(commands));
  if (target.section !== 'state') {
    for (const key of ungrouped) {
      // The signature rides in `description` rather than in a field of its own because
      // that is the part of a `resource_link` a model is certain to read — the same
      // reasoning as the window list door, which shares `commandLinkDescription`.
      links.push({
        uri: `${base}/commands/${key}`,
        name: `commands/${key}`,
        description: commandLinkDescription(key, commands[key], defs),
      });
    }
    // One link per group, naming its commands — the chapter list. A row per grouped
    // command would be read here and again in the chapter.
    for (const [group, keys] of groups) {
      links.push({
        uri: `${base}/commands/${group}`,
        name: `commands/${group}`,
        description: `group — ${keys.join(', ')}`,
      });
    }
  }

  return prependNote(
    okLinks(links),
    groups.size > 0
      ? `the index — read("${base}/commands/{group}") gives a group's commands in full, ` +
          `read("${base}/commands/{group}/{name}") one; brace-batch either: {a,b,c}`
      : `the index — descriptions are summarized to their first sentence; read("${base}/commands/{name}") ` +
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
