/**
 * Reading a protocol schema that points at the manifest's `$defs` table.
 *
 * The compiler hoists subschemas an app repeats — one texture-slot shape stated
 * fifteen times becomes one `$defs` entry and fifteen pointers
 * (`packages/compiler/src/protocol/dedupe-schemas.ts`). That is lossless only if
 * everything reading a schema can follow a pointer, so the two things the server
 * does with a schema each get one function here:
 *
 *  - **render it** (`renderType`, `renderSignature`) — needs the node behind a ref,
 *    one hop at a time. That is `resolveRef`.
 *  - **hand one descriptor's schema on by itself** (`describe` of a single command,
 *    which answers with `schema:`) — needs the slice to stand alone. That is
 *    `selfContained`, which attaches the defs the slice reaches rather than inlining
 *    them: inlining re-creates exactly the duplication the hoist removed, and a
 *    recursive schema has no inlined form at all.
 *
 * A manifest with no `$defs` is the common case and every function here is a
 * pass-through for it.
 */

const REF_PREFIX = '#/$defs/';

/** The `$defs` table of one manifest, as read off an untyped manifest object. */
export type SchemaDefs = Record<string, unknown> | undefined;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `$defs` of a manifest-shaped value, or undefined when it declares none. */
export function defsOf(manifest: unknown): SchemaDefs {
  const defs = (manifest as { $defs?: unknown } | null | undefined)?.$defs;
  return isPlainObject(defs) ? defs : undefined;
}

/**
 * The schema `node` stands for: itself, or what its `$ref` points at.
 *
 * Follows a chain of refs (a def may be a pointer to another def after a merge) and
 * gives up rather than looping on a cycle — a recursive schema is legal, and the
 * callers all want *a* node to read, not a guarantee of termination they can't get.
 * An unresolvable ref returns the node untouched, which renders as `any`: the same
 * answer as before this existed, rather than a thrown error inside a describe.
 */
export function resolveRef(node: unknown, defs: SchemaDefs): unknown {
  if (!defs) return node;
  let current = node;
  for (let hop = 0; hop < 16; hop++) {
    if (!isPlainObject(current)) return current;
    const ref = current.$ref;
    if (typeof ref !== 'string' || !ref.startsWith(REF_PREFIX)) return current;
    const target = defs[ref.slice(REF_PREFIX.length)];
    if (!isPlainObject(target)) return current;
    // A `$ref` beside other keys is legal in 2020-12; the siblings win, so a
    // `description` written at the use site is not lost to the shared shape.
    const siblings = Object.entries(current).filter(([key]) => key !== '$ref');
    current = siblings.length === 0 ? target : { ...target, ...Object.fromEntries(siblings) };
  }
  return current;
}

/** Every `$defs` name reachable from `value`, following refs through the defs themselves. */
function reachableDefs(value: unknown, defs: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  const frontier: unknown[] = [value];
  while (frontier.length > 0) {
    const node = frontier.pop();
    if (Array.isArray(node)) {
      frontier.push(...node);
      continue;
    }
    if (!isPlainObject(node)) continue;
    for (const [key, child] of Object.entries(node)) {
      if (key === '$ref' && typeof child === 'string' && child.startsWith(REF_PREFIX)) {
        const name = child.slice(REF_PREFIX.length);
        if (found.has(name)) continue;
        found.add(name);
        if (name in defs) frontier.push(defs[name]);
      } else {
        frontier.push(child);
      }
    }
  }
  return found;
}

/**
 * One descriptor's schema, carrying the defs it points at so it can be read alone.
 *
 * The returned object is the schema document: its `#/$defs/...` pointers resolve
 * against its own `$defs`. Returned unchanged when the schema references nothing,
 * which keeps the answer for the overwhelming majority of commands byte-identical
 * to what it was.
 */
export function selfContained(schema: unknown, defs: SchemaDefs): unknown {
  if (!defs || !isPlainObject(schema)) return schema;
  const names = reachableDefs(schema, defs);
  if (names.size === 0) return schema;
  const table: Record<string, unknown> = {};
  for (const name of [...names].sort()) {
    if (name in defs) table[name] = defs[name];
  }
  if (Object.keys(table).length === 0) return schema;
  return { ...schema, $defs: table };
}
