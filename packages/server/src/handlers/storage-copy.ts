/**
 * The shape of a `copy` invoke, in one place.
 *
 * `invoke { action: 'copy', from }` is the one storage action that *reads* a URI the
 * caller did not name as its target, so `POST /api/verb` re-checks `read` on `from`
 * before dispatching: without it an app permitted to write its own storage could name
 * any source and pull the bytes in — a read grant for the whole tree, spelled as a
 * write. The storage handlers themselves perform no authorization at all, so that door
 * check is the whole of the invariant.
 *
 * It was enforced by duck-typing (`element?.action !== 'copy'`, `element.from`) against
 * a payload shape that three other files defined independently: two handlers that
 * implement `copy` (`handlers/storage.ts`, `handlers/apps/storage-resource.ts`) and the
 * composite `yaar://apps/*` registration that advertises it. Nothing linked the
 * enforcement to the implementation, so a renamed field would have uncovered the check
 * silently — the copies would still work, and the `read` gate would simply stop firing.
 * (The drift had already started: the composite schema listed `copy` in its action enum
 * and declared no `from` property at all.)
 *
 * So the field name, its schema, its error message and the extraction the gate runs all
 * live here, and every site imports them. A rename now breaks the build.
 */

import type { InvokePayload } from './uri-registry.js';

/** The action name. Compared against, never re-spelled. */
export const COPY_ACTION = 'copy';

/**
 * The `from` property, as every door that accepts a copy declares it.
 *
 * Both spellings of a storage URI are accepted because `canonicalStorageUri`
 * (http/access.ts) matches them as the same file either way.
 */
export const COPY_FROM_SCHEMA = {
  type: 'string',
  description:
    'Source yaar:// storage URI to copy bytes from (copy). Either spelling works: ' +
    'yaar://storage/… or yaar://apps/{id}/storage/…',
} as const;

/** The refusal when a copy names no usable source. One wording, four sites. */
export const COPY_FROM_REQUIRED = '"from" (a yaar:// storage URI) is required for copy.';

/** Does this payload name the copy action? */
export function isCopyPayload(payload?: Record<string, unknown>): boolean {
  return payload?.action === COPY_ACTION;
}

/** The source URI a copy payload names, or `null` when it names none usable. */
export function copyFrom(payload?: Record<string, unknown>): string | null {
  const from = payload?.from;
  return typeof from === 'string' ? from : null;
}

/**
 * Every source URI an invoke payload will read, for the gate that must check them.
 *
 * Handles both payload axes because the door sees both: an object payload is one
 * call, an array payload is N calls the registry runs *without* coming back through
 * the door, so checking only the object form would make the array form the bypass.
 *
 * Returns an error message instead when an element names `copy` with no usable
 * `from` — the gate refuses it there rather than letting the handler discover it,
 * since a copy the gate cannot check is a copy the gate cannot allow.
 */
export function copySources(
  payload: InvokePayload | undefined,
): { sources: string[] } | { error: string } {
  const sources: string[] = [];
  for (const element of Array.isArray(payload) ? payload : [payload]) {
    if (!isCopyPayload(element)) continue;
    const from = copyFrom(element);
    if (from === null) return { error: COPY_FROM_REQUIRED };
    sources.push(from);
  }
  return { sources };
}
