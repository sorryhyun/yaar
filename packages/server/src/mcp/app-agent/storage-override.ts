/**
 * Storage overrides — an app taking one of the built-in `storage:*` calls for itself.
 *
 * The four built-ins (`storage:read` / `storage:write` / `storage:delete` / `storage:list`,
 * and the `storage/{path}` spelling of `query` that is `storage:read` by another name)
 * move raw bytes. That is right for an app that keeps files, and wrong for an app whose
 * files are *renderings* of something else: word-excel's document is one thing, and the
 * `.docx`, `.md` and `.json` it saves are that thing in three formats. Writing `content`
 * verbatim to `report.docx` gives such an app a file it cannot open, so it shipped a
 * `saveToStorage` of its own — and its agent then held two write calls with the same
 * verb and different semantics, one of which produced garbage.
 *
 * An override collapses them: an app that declares a command **named** `storage:write`,
 * or **aliases** one of its own commands to that name, is handed the call instead of the
 * built-in, params intact. The agent keeps typing the spelling the prompt taught it, and
 * `describe` shows the app's own description for what it now does.
 *
 * ── What is overridable ──
 *
 * The **relative** spelling only — the app's own tree. A `yaar://storage/...` path names
 * the shared tree, whose every call past the commons is gated on `app.json`; letting an
 * app intercept it would put the app's code between the agent and that gate, and the
 * gate is the point. So a shared-tree call always reaches the built-in, override or not.
 * `yaar://apps/self/storage/...` is normalized to relative before this is asked, so it
 * overrides like the relative form it is.
 *
 * ── Why the declaration is the protocol, not app.json ──
 *
 * The override is a command; commands live in the protocol. An app that can answer
 * `storage:write` has a handler for it, and the handler is what the compiler extracts
 * — no second table to keep agreeing with the first, and no way to declare an override
 * without also implementing it.
 */
import type { AppManifest } from '@yaar/shared';
import { listApps } from '../../features/apps/discovery.js';

export type StorageVerb = 'read' | 'write' | 'delete' | 'list';

export const STORAGE_VERBS: readonly StorageVerb[] = ['read', 'write', 'delete', 'list'];

/** The built-in spelling of a storage verb, which is also the name an override claims. */
export function storageCommandName(verb: StorageVerb): string {
  return `storage:${verb}`;
}

/**
 * The canonical name of the app command that overrides `storage:{verb}`, or null when
 * the app declares none. Pure over the protocol table so it can be pinned without a disk.
 */
export function storageOverrideIn(
  commands: AppManifest['commands'] | undefined,
  verb: StorageVerb,
): string | null {
  if (!commands) return null;
  const name = storageCommandName(verb);
  if (name in commands) return name;
  for (const [canonical, descriptor] of Object.entries(commands)) {
    if (descriptor?.aliases?.includes(name)) return canonical;
  }
  return null;
}

/** {@link storageOverrideIn} against the installed app's compiled protocol. */
export async function findStorageOverride(
  appId: string,
  verb: StorageVerb,
): Promise<string | null> {
  const app = (await listApps()).find((a) => a.id === appId);
  return storageOverrideIn(app?.protocol?.commands, verb);
}

/**
 * The parenthetical that opens an overridden call's answer. The answer itself is the
 * app's; this says why it is not the built-in's, so an agent reading "Saved as .docx"
 * where it expected the built-in's `{ uri, written }` knows which door it went through.
 */
export function overrideNote(verb: StorageVerb, canonical: string): string {
  const spelled = storageCommandName(verb);
  return canonical === spelled
    ? `(This app overrides the built-in ${spelled}; the answer below is the app's own.)`
    : `(This app overrides the built-in ${spelled} with its "${canonical}" command; the answer below is the app's own.)`;
}
