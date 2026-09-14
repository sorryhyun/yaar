/**
 * The shape of an invoke that reads a URI other than its target, in one place.
 *
 * `invoke { action: 'copy', from }` reads a URI the caller did not name as its target, and so do
 * `extract` (the archive to unpack) and `compress` (the files to pack). So `POST /api/verb`
 * re-checks `read` on every `from` before dispatching: without it an app permitted to write its
 * own storage could name any source and pull the bytes in — a read grant for the whole tree,
 * spelled as a write. The storage handlers themselves perform no authorization at all, so that
 * door check is the whole of the invariant.
 *
 * It was enforced by duck-typing (`element?.action !== 'copy'`, `element.from`) against a payload
 * shape that three other files defined independently: two handlers that implement `copy`
 * (`handlers/storage.ts`, `handlers/apps/storage-resource.ts`) and the composite `yaar://apps/*`
 * registration that advertises it. Nothing linked the enforcement to the implementation, so a
 * renamed field would have uncovered the check silently — the copies would still work, and the
 * `read` gate would simply stop firing. (The drift had already started: the composite schema
 * listed `copy` in its action enum and declared no `from` property at all.)
 *
 * So the action names, the field, its schema, its error message and the extraction the gate runs
 * all live here, and every site imports them. A new source-reading action is one entry in
 * `SOURCE_ACTIONS`, and the gate covers it from that line.
 */

import { resolveSelf } from '../http/uri-match.js';
import type { InvokePayload } from './uri-registry.js';

/** The action names. Compared against, never re-spelled. */
export const COPY_ACTION = 'copy';
export const EXTRACT_ACTION = 'extract';
export const COMPRESS_ACTION = 'compress';

/** Every action whose `from` the door must be allowed to read. */
const SOURCE_ACTIONS: ReadonlySet<unknown> = new Set([
  COPY_ACTION,
  EXTRACT_ACTION,
  COMPRESS_ACTION,
]);

/**
 * The `from` property, as every door that accepts a source-reading action declares it.
 *
 * Both spellings of a storage URI are accepted because `canonicalStorageUri`
 * (http/access.ts) matches them as the same file either way.
 */
export const FROM_SCHEMA = {
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  description:
    'Source yaar:// storage URI. copy: the file to copy bytes from. extract: the archive ' +
    '(.zip, .tar, .tar.gz, .tgz) to unpack into the target folder. compress: the file or folder ' +
    'to pack into the target archive, or an array of them. Either spelling works: ' +
    'yaar://storage/… or yaar://apps/{id}/storage/…',
} as const;

/** The refusal when a source-reading action names no usable source. One wording, every site. */
export function sourcesRequired(action: string): string {
  return `"from" (a yaar:// storage URI) is required for ${action}.`;
}

export const COPY_FROM_REQUIRED = sourcesRequired(COPY_ACTION);

/** Does this payload name the copy action? */
export function isCopyPayload(payload?: Record<string, unknown>): boolean {
  return payload?.action === COPY_ACTION;
}

/** The source URI a copy payload names, or `null` when it names none usable. */
export function copyFrom(payload?: Record<string, unknown>): string | null {
  const from = payload?.from;
  return typeof from === 'string' ? from : null;
}

/** Does this payload name an action that reads `from`? */
function readsSources(payload?: Record<string, unknown>): boolean {
  return SOURCE_ACTIONS.has(payload?.action);
}

/**
 * The source URIs one payload reads, or `null` when it names none usable.
 *
 * `compress` alone takes an array; every other action takes exactly one URI.
 */
export function payloadSources(payload?: Record<string, unknown>): string[] | null {
  const from = payload?.from;
  if (typeof from === 'string') return [from];
  if (
    payload?.action === COMPRESS_ACTION &&
    Array.isArray(from) &&
    from.length > 0 &&
    from.every((source) => typeof source === 'string')
  ) {
    return from as string[];
  }
  return null;
}

/**
 * Every source URI an invoke payload will read, for the gate that must check them.
 *
 * Handles both payload axes because the door sees both: an object payload is one
 * call, an array payload is N calls the registry runs *without* coming back through
 * the door, so checking only the object form would make the array form the bypass.
 *
 * Returns an error message instead when an element names a source-reading action with no usable
 * `from` — the gate refuses it there rather than letting the handler discover it, since a source
 * the gate cannot check is a source the gate cannot allow.
 */
export function invokeSources(
  payload: InvokePayload | undefined,
): { sources: string[] } | { error: string } {
  const sources: string[] = [];
  for (const element of Array.isArray(payload) ? payload : [payload]) {
    if (!readsSources(element)) continue;
    const from = payloadSources(element);
    if (from === null) return { error: sourcesRequired(String(element?.action)) };
    sources.push(...from);
  }
  return { sources };
}

/**
 * The payload to dispatch, with `self` expanded in every source.
 *
 * The target URI has always been expanded before dispatch (`resolveSelf` in
 * `routes/verb.ts`) and the permission gate expands *both* sides — `permissionsAllow`
 * resolves the pronoun before it matches. Only the source that finally reaches the
 * handler was left with the literal word in it, so `from: 'yaar://apps/self/storage/x'`
 * passed the read check and then looked for an app whose id is `self`: the copy that
 * imports *into* an app's own storage worked, and the export back out of it did not,
 * with a "File not found" that named a path the caller never wrote.
 *
 * Returns the payload unchanged — same reference — when there is nothing to expand, so
 * the ordinary call allocates nothing.
 */
export function resolveInvokeSources(
  payload: InvokePayload | undefined,
  appId: string | undefined,
): InvokePayload | undefined {
  if (!appId || payload === undefined) return payload;

  const expand = (element: Record<string, unknown> | undefined) => {
    if (!readsSources(element)) return element;
    const from = element?.from;
    if (typeof from === 'string') {
      const resolved = resolveSelf(from, appId);
      return resolved === from ? element : { ...element, from: resolved };
    }
    if (Array.isArray(from)) {
      const resolved = from.map((source) =>
        typeof source === 'string' ? resolveSelf(source, appId) : source,
      );
      return resolved.some((source, i) => source !== from[i])
        ? { ...element, from: resolved }
        : element;
    }
    return element;
  };

  if (!Array.isArray(payload)) return expand(payload);
  const expanded = payload.map(expand);
  return expanded.some((element, i) => element !== payload[i])
    ? (expanded as InvokePayload)
    : payload;
}
