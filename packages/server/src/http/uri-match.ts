/**
 * Matching a `yaar://` URI against a permission list.
 *
 * Pulled out of `access.ts` so it has no imports of its own beyond a type: it is the
 * one definition of "does this entry cover this verb on this URI", and two callers now
 * need it from opposite sides of a module cycle. `access.ts` asks it at the gate;
 * `iframe-tokens.ts` asks it when minting a devtools preview's identity, to cap what a
 * project file may declare against what devtools itself holds. `access.ts` imports
 * `iframe-tokens.js` at runtime, so that second caller could not simply import the gate
 * — and a second copy of `uriMatches` is exactly the drift that would let a prefix mean
 * one thing at mint time and another at the door.
 *
 * `access.ts` re-exports both names, so its callers are unchanged and it stays the
 * place you read to learn the rule.
 */

import type { Verb } from '../handlers/uri-registry.js';
import type { PermissionEntry } from './access.js';

/** Every verb a string permission entry implies. */
export const ALL_VERBS: readonly Verb[] = ['describe', 'read', 'list', 'invoke', 'delete'];

/**
 * A trailing slash is what makes a pattern a *prefix*; without one it names exactly
 * one resource. `uri + '/' === pattern` lets `yaar://storage` match the entry
 * `yaar://storage/` — the directory itself, named without its slash.
 */
export function uriMatches(uri: string, pattern: string): boolean {
  return (
    uri === pattern || (pattern.endsWith('/') && (uri.startsWith(pattern) || uri + '/' === pattern))
  );
}

export function isUriAllowed(uri: string, verb: Verb, entries: PermissionEntry[]): boolean {
  return entries.some((entry) => {
    if (typeof entry === 'string') {
      return uriMatches(uri, entry); // string entry → all verbs allowed
    }
    return uriMatches(uri, entry.uri) && (!entry.verbs || entry.verbs.includes(verb));
  });
}

/** The verbs an entry actually confers, whichever of the two spellings it uses. */
export function entryVerbs(entry: PermissionEntry): readonly Verb[] {
  return typeof entry === 'string' ? ALL_VERBS : (entry.verbs ?? ALL_VERBS);
}

/** The URI an entry names, whichever of the two spellings it uses. */
export function entryUri(entry: PermissionEntry): string {
  return typeof entry === 'string' ? entry : entry.uri;
}
