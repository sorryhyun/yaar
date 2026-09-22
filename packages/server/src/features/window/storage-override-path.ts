/**
 * The path contract of a storage override, held for every door that forwards a command.
 *
 * An app that declares `storage:write` (or aliases a command to it — see
 * `mcp/app-agent/storage-override.ts`) is promised a `path` it can resolve on its own
 * authority: a relative path in its own tree, or a URI in the commons
 * (`yaar://storage/shared/…`). The rest of the shared tree is gated on `app.json`, and an
 * override never stands in front of that gate.
 *
 * The app agent's `command()` tool kept the promise by routing: a deeper `yaar://storage/`
 * path went to the gated built-in and never reached the app. Every other door —
 * `app_command`, `invoke("yaar://windows/{id}/commands/storage:write")`, and the app
 * agent's own `command()` under a *non-built-in* name that aliases one — forwarded the
 * raw URI straight to the handler (#91). word-excel, trusting the contract, stripped it
 * and saved into its private tree, so a caller that named `yaar://storage/temp/x.md` got
 * a success for a file written somewhere else.
 *
 * Those doors have no built-in to fall back to, so this refuses rather than routes. It
 * lives here, under `handleAppCommand`, so the contract is kept once for every caller.
 */
import type { AppManifest } from '@yaar/shared';
import { canonicalStorageUri } from '../../http/uri-match.js';

const STORAGE_VERB_NAMES = new Set([
  'storage:read',
  'storage:write',
  'storage:delete',
  'storage:list',
]);

const SHARED_ROOT = 'yaar://storage';
const COMMONS = `${SHARED_ROOT}/shared`;

/**
 * The `path` param when it names the shared tree past the commons (or traverses), which
 * an override may never receive; `null` for every path it may. Cheap and manifest-free,
 * so the ordinary command pays for nothing more.
 */
export function gatedStoragePath(params: Record<string, unknown> | undefined): string | null {
  const path = params?.path;
  if (typeof path !== 'string') return null;
  if (path !== SHARED_ROOT && !path.startsWith(`${SHARED_ROOT}/`)) return null;
  const canonical = canonicalStorageUri(path);
  if (canonical !== null && (canonical === COMMONS || canonical.startsWith(`${COMMONS}/`)))
    return null;
  return path;
}

/**
 * Does `command` run a storage override — the built-in spelling itself, or a command
 * whose aliases claim one? `commands` is only consulted for the second, and may be absent
 * when the caller already knows the name is a built-in spelling.
 */
export function isStorageOverrideCommand(
  command: string,
  commands: AppManifest['commands'] | undefined,
): boolean {
  if (STORAGE_VERB_NAMES.has(command)) return true;
  const aliases = commands?.[command]?.aliases;
  return Array.isArray(aliases) && aliases.some((a) => STORAGE_VERB_NAMES.has(a));
}

/** The refusal a caller gets, naming the spellings that would have worked. */
export function gatedStoragePathError(command: string, path: string): string {
  return (
    `"${command}" is this app's override of a built-in storage command, and an override ` +
    `only takes a path in the app's own storage (relative) or in the commons ` +
    `(yaar://storage/shared/…). "${path}" is past the commons, where access is gated on ` +
    `app.json — so it is refused rather than handed to the app. Pass a relative path or a ` +
    `yaar://storage/shared/ path instead.`
  );
}
