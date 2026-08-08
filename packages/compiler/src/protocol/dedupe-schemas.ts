/**
 * Hoist repeated subschemas out of an app's protocol into one `$defs` table.
 *
 * The manifest an agent reads is the app's manual, and for a schema-heavy app the
 * manual is mostly *restatement*: `fold-schemas.ts` inlines every Zod schema with
 * no sharing, so one 626-byte texture-slot shape appeared five times inside a
 * single `setMaterial` and ~15 times across studio-3d's protocol. That is not a
 * content problem — the descriptions are the product — it is a *representation*
 * problem, and past ~50 KB the Claude CLI stops delivering a tool result inline and
 * replaces it with a path on disk that a verbs-only agent cannot open. The failure
 * is total rather than gradual, so bytes that say nothing new are worth removing.
 *
 * The pass is content-neutral: resolving every `$ref` it emits reproduces the input
 * exactly, property order included. `map: {"$ref": "#/$defs/uri_repeat_offset_etc"}`
 * five times is arguably the better manual — it says "the same shape" instead of
 * making the reader diff five 200-byte blobs.
 *
 * Four rules, each load-bearing:
 *
 *  - **A descriptor's top-level schema is never hoisted.** The iframe bridge reads
 *    `params.properties` and `params.required` directly to reject a call before the
 *    handler runs (`iframe-scripts/app-protocol.ts`), and `renderSignature` reads the
 *    same two keys. A `params` replaced by a bare `$ref` would turn both into
 *    "declares nothing", which is silently *weaker* validation rather than an error.
 *  - **Refs are protocol-relative** (`#/$defs/name`), so the protocol object is the
 *    schema document. Zod's own `reused: 'ref'` emits a `$defs` local to one
 *    descriptor, whose pointers would resolve against the wrong root once that
 *    descriptor is embedded in protocol.json — those are promoted here, which is why
 *    Change 1 and Change 2 of the proposal ship together.
 *  - **Renaming and pruning read `$ref` generically**, not through the schema-aware
 *    walk: a hand-authored protocol.json may put a ref somewhere this file does not
 *    recognize as a subschema position, and a rename that misses it would produce a
 *    dangling pointer. Counting and substitution stay schema-aware, because treating
 *    an arbitrary object (a `properties` map, an `examples` entry) as a schema is how
 *    a "deduplication" pass corrupts a manifest.
 *  - **Idempotent.** Names already in `$defs` are kept, so running the pass over its
 *    own output changes nothing — which is what makes the compile and the deploy-time
 *    re-derivation agree (`deploy.ts` diffs the two).
 */

/** A JSON object, which is what every schema node this pass touches is. */
type SchemaObject = Record<string, unknown>;

/**
 * The protocol shape this pass reads. Deliberately structural rather than the
 * `AppManifest` Pick: the deploy path and the fold hand over the same three schema
 * positions under slightly different surrounding types.
 */
export interface DedupableProtocol {
  // `description` is named only so a descriptor that declares no schema still has a
  // property in common with this type — without it TypeScript's weak-type check
  // rejects the perfectly ordinary `{ description: 'Ping' }`.
  state?: Record<string, { description?: string; schema?: object }>;
  commands?: Record<string, { description?: string; params?: object; returns?: object }>;
  $defs?: Record<string, object>;
}

/** What the pass hands back: the caller's own protocol type, plus the table it may have filled. */
export type DedupedProtocol<T> = T & { $defs?: Record<string, object> };

/**
 * Below this, a `$ref` costs about what it saves: the pointer is ~30 bytes, the
 * `$defs` entry adds the name again, and a manual that trades a readable 80-byte
 * shape for an indirection is worse for the reader as well as no smaller.
 */
const MIN_HOISTED_BYTES = 120;

/** Rounds of count-then-hoist. A round only ever runs when the previous one changed something. */
const MAX_ROUNDS = 8;

/** Keys whose value is one subschema. */
const CHILD_KEYS = [
  'items',
  'additionalItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contentSchema',
  'additionalProperties',
] as const;

/** Keys whose value is a map of name → subschema. */
const CHILD_MAP_KEYS = ['properties', 'patternProperties', 'dependentSchemas'] as const;

/** Keys whose value is an array of subschemas. */
const CHILD_LIST_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;

const REF_PREFIX = '#/$defs/';

function isPlainObject(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A node that is nothing but a pointer — hoisting one would only alias it. */
function isRefOnly(node: SchemaObject): boolean {
  const keys = Object.keys(node);
  return keys.length === 1 && keys[0] === '$ref';
}

/** The canonical form two subschemas must share to count as the same one. */
function canonical(node: unknown): string {
  return JSON.stringify(node);
}

/**
 * Rebuild `node` with every subschema position mapped through `fn`, preserving key
 * order. Keys this file does not recognize as subschema positions are copied as-is.
 */
function mapChildren(node: SchemaObject, fn: (child: unknown) => unknown): SchemaObject {
  const out: SchemaObject = {};
  for (const [key, value] of Object.entries(node)) {
    if ((CHILD_KEYS as readonly string[]).includes(key)) {
      out[key] = isPlainObject(value) ? fn(value) : value;
    } else if ((CHILD_MAP_KEYS as readonly string[]).includes(key) && isPlainObject(value)) {
      const mapped: SchemaObject = {};
      for (const [name, child] of Object.entries(value)) {
        mapped[name] = isPlainObject(child) ? fn(child) : child;
      }
      out[key] = mapped;
    } else if ((CHILD_LIST_KEYS as readonly string[]).includes(key) && Array.isArray(value)) {
      out[key] = value.map((child) => (isPlainObject(child) ? fn(child) : child));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Visit every subschema of `node`, `node` itself excluded. */
function eachChild(node: SchemaObject, visit: (child: SchemaObject) => void): void {
  mapChildren(node, (child) => {
    if (isPlainObject(child)) visit(child);
    return child;
  });
}

/**
 * Rewrite `$ref` targets anywhere in `value`, by a walk that knows nothing about
 * schema vocabulary. See the header: a rename that only followed recognized
 * subschema positions would leave a dangling pointer in a hand-authored manifest.
 */
function renameRefs(value: unknown, renames: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => renameRefs(item, renames));
  if (!isPlainObject(value)) return value;
  const out: SchemaObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string' && child.startsWith(REF_PREFIX)) {
      const target = renames.get(child.slice(REF_PREFIX.length));
      out[key] = target ? REF_PREFIX + target : child;
    } else {
      out[key] = renameRefs(child, renames);
    }
  }
  return out;
}

/**
 * Replace every pointer into `table` with the schema it names, by the same generic
 * walk as `renameRefs`. Callers guarantee the table's values hold no `$ref`, so one
 * pass suffices and a recursive def can never be reached.
 */
function expandRefs(value: unknown, table: Map<string, SchemaObject>): unknown {
  if (Array.isArray(value)) return value.map((item) => expandRefs(item, table));
  if (!isPlainObject(value)) return value;
  const ref = value.$ref;
  if (typeof ref === 'string' && ref.startsWith(REF_PREFIX)) {
    const target = table.get(ref.slice(REF_PREFIX.length));
    if (target) {
      // A `$ref` with siblings is legal in 2020-12 and the siblings win, matching
      // `resolveSchemaRefs` — the pass never emits one, but a promoted table may.
      const rest = Object.entries(value).filter(([key]) => key !== '$ref');
      return rest.length === 0 ? { ...target } : { ...target, ...Object.fromEntries(rest) };
    }
  }
  const out: SchemaObject = {};
  for (const [key, child] of Object.entries(value)) out[key] = expandRefs(child, table);
  return out;
}

/** Every `$defs` name `value` points at, found the same generic way. */
function collectRefNames(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRefNames(item, into);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string' && child.startsWith(REF_PREFIX)) {
      into.add(child.slice(REF_PREFIX.length));
    } else {
      collectRefNames(child, into);
    }
  }
}

/** A name fragment safe to put in a JSON Pointer and readable in a manifest. */
function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * A name derived from the shape itself, because the primary reader is a model and
 * the name is documentation. `{x,y,z}` becomes `x_y_z`, not `__schema0`.
 */
function deriveName(value: SchemaObject): string {
  if (Array.isArray(value.enum) && value.enum.length > 0) {
    const first = value.enum.find((entry) => typeof entry === 'string');
    const tail = typeof first === 'string' ? slug(first) : '';
    return tail ? `enum_${tail}` : 'enum';
  }
  if (isPlainObject(value.properties)) {
    const keys = Object.keys(value.properties);
    if (keys.length > 0) {
      const shown = keys.slice(0, 3).map(slug).filter(Boolean);
      if (shown.length > 0) return shown.join('_') + (keys.length > 3 ? '_etc' : '');
    }
  }
  if (isPlainObject(value.items)) return `${deriveName(value.items)}_list`;
  if (Array.isArray(value.anyOf) || Array.isArray(value.oneOf)) return 'union';
  if (typeof value.type === 'string') return slug(value.type) || 'schema';
  return 'schema';
}

/**
 * One of the three positions in a protocol that holds a schema
 * (`state.*.schema`, `commands.*.params`, `commands.*.returns`), as a read/write
 * pair over the shallow copy — so the walk below never has to know the shape of a
 * descriptor, only that this is a schema root and must not be hoisted.
 */
interface SchemaSlot {
  read(): unknown;
  write(value: SchemaObject): void;
}

/** Enumerate the protocol's schema slots over a shallow-copied protocol. */
function slotsOf(protocol: DedupableProtocol): { copy: SchemaObject; slots: SchemaSlot[] } {
  const copy: SchemaObject = { ...(protocol as SchemaObject) };
  const slots: SchemaSlot[] = [];

  for (const [section, props] of [
    ['state', ['schema']],
    ['commands', ['params', 'returns']],
  ] as const) {
    const table = (protocol as SchemaObject)[section];
    if (!isPlainObject(table)) continue;
    const rebuilt: Record<string, SchemaObject> = {};
    for (const [key, descriptor] of Object.entries(table)) {
      const entry: SchemaObject = { ...(descriptor as SchemaObject) };
      rebuilt[key] = entry;
      for (const prop of props) {
        if (!isPlainObject(entry[prop])) continue;
        slots.push({
          read: () => entry[prop],
          write: (value) => {
            entry[prop] = value;
          },
        });
      }
    }
    copy[section] = rebuilt;
  }

  return { copy, slots };
}

/**
 * Fold repeated subschemas of `protocol` into a protocol-level `$defs`.
 *
 * Returns a new protocol; the input is never mutated. A protocol with no schemas —
 * most apps — comes back without a `$defs` key at all, so nothing new appears in a
 * manifest that had nothing to share.
 */
export function dedupeProtocolSchemas<T extends DedupableProtocol>(
  protocol: T,
  options: { minBytes?: number } = {},
): DedupedProtocol<T> {
  const minBytes = options.minBytes ?? MIN_HOISTED_BYTES;
  const { copy, slots } = slotsOf(protocol);

  /** name → value. Insertion order is the tiebreaker every deterministic choice below uses. */
  const defs = new Map<string, SchemaObject>();
  /** Names already spoken for, so a new one never shadows an existing def. */
  const taken = new Set<string>();
  /** Names this pass minted, which are the only ones renamed to a derived name at the end. */
  const provisional = new Set<string>();
  let counter = 0;

  const reserve = (name: string): string => {
    let candidate = name;
    let suffix = 2;
    while (taken.has(candidate)) candidate = `${name}_${suffix++}`;
    taken.add(candidate);
    return candidate;
  };

  const mint = (value: SchemaObject): string => {
    const name = reserve(`__p${counter++}`);
    provisional.add(name);
    defs.set(name, value);
    return name;
  };

  // Seed from an existing `$defs` under the names it already uses, which is what
  // makes a second run over this pass's own output a no-op.
  if (isPlainObject(protocol.$defs)) {
    for (const [name, value] of Object.entries(protocol.$defs)) {
      if (!isPlainObject(value)) continue;
      defs.set(reserve(name), value);
    }
  }

  // ── Promote each descriptor's own `$defs` (zod's `reused: 'ref'`) ───────────
  //
  // Provisional names first, then rewrite the whole descriptor — value order does
  // not matter this way, so a def that references another def (or itself, which a
  // recursive schema produces) needs no dependency ordering and cannot loop.
  for (const slot of slots) {
    const root = slot.read();
    if (!isPlainObject(root)) continue;
    const local = root.$defs;
    if (!isPlainObject(local)) {
      slot.write(root);
      continue;
    }
    const renames = new Map<string, string>();
    const pending: Array<[string, SchemaObject]> = [];
    for (const [name, value] of Object.entries(local)) {
      if (!isPlainObject(value)) continue;
      const minted = reserve(`__p${counter++}`);
      provisional.add(minted);
      renames.set(name, minted);
      pending.push([minted, value]);
    }
    for (const [name, value] of pending) {
      defs.set(name, renameRefs(value, renames) as SchemaObject);
    }
    const { $defs: _dropped, ...rest } = root;
    slot.write(renameRefs(rest, renames) as SchemaObject);
  }

  // ── Undo a promotion that costs more than it saves ─────────────────────────
  //
  // The step above takes zod's table wholesale, and zod hoists by *instance
  // identity* with no size rule of its own: studio-3d arrived with
  // `{"type":"number"}` behind a 25-byte pointer at 70 sites and
  // `{"type":"boolean"}` at 32 more. That is bigger than the shape it replaces at
  // every single use, and `{"$ref":"#/$defs/number"}` is worse documentation than
  // `{"type":"number"}` besides — the same reason the hoist loop below declines
  // anything under `minBytes`.
  //
  // The test is the narrow one that cannot be wrong at any use count: the def is
  // no larger than one pointer to it. A def big enough to pay for itself is left
  // alone whatever its name, and only defs *this pass minted* are undone — a
  // hand-authored `$defs` is the author's document structure, not a finding.
  const overpriced = new Map<string, SchemaObject>();
  for (const [name, value] of defs) {
    if (!provisional.has(name)) continue;
    const text = canonical(value);
    // A def that points at another has no single-pass inlined form, and a
    // self-referential one has none at all.
    if (text.includes('"$ref"')) continue;
    if (text.length > canonical({ $ref: REF_PREFIX + deriveName(value) }).length) continue;
    overpriced.set(name, value);
  }
  if (overpriced.size > 0) {
    for (const slot of slots) slot.write(expandRefs(slot.read(), overpriced) as SchemaObject);
    for (const [name, value] of defs) defs.set(name, expandRefs(value, overpriced) as SchemaObject);
    for (const name of overpriced.keys()) defs.delete(name);
  }

  /** Apply a rename map to every schema slot and every def value at once. */
  const applyRenames = (renames: Map<string, string>): void => {
    if (renames.size === 0) return;
    for (const slot of slots) slot.write(renameRefs(slot.read(), renames) as SchemaObject);
    for (const [name, value] of defs) defs.set(name, renameRefs(value, renames) as SchemaObject);
  };

  /**
   * Collapse defs that hold the same schema. Runs to a fixpoint because merging two
   * defs can make two *other* defs — which referenced them under different names —
   * identical in turn.
   */
  const mergeIdentical = (): void => {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const winners = new Map<string, string>();
      const renames = new Map<string, string>();
      for (const [name, value] of defs) {
        const key = canonical(value);
        const winner = winners.get(key);
        if (winner === undefined) winners.set(key, name);
        else renames.set(name, winner);
      }
      if (renames.size === 0) return;
      for (const name of renames.keys()) defs.delete(name);
      applyRenames(renames);
    }
  };

  // ── Hoist subschemas that appear more than once ────────────────────────────
  for (let round = 0; round < MAX_ROUNDS; round++) {
    mergeIdentical();

    const counts = new Map<string, number>();
    const count = (node: unknown, atRoot: boolean): void => {
      if (!isPlainObject(node)) return;
      if (!atRoot && !isRefOnly(node)) {
        const key = canonical(node);
        if (key.length >= minBytes) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      eachChild(node, (child) => count(child, false));
    };
    for (const slot of slots) count(slot.read(), true);
    for (const value of defs.values()) count(value, true);

    // Two ways a subschema earns a pointer: it is stated at least twice, or a def for
    // that exact shape already exists — a shape promoted out of one descriptor and
    // written inline in another is one shape, however it got here.
    const targets = new Map<string, string>();
    for (const [name, value] of defs) targets.set(canonical(value), name);
    let minted = 0;
    for (const [key, seen] of counts) {
      if (seen < 2 || targets.has(key)) continue;
      targets.set(key, mint(JSON.parse(key) as SchemaObject));
      minted++;
    }

    const substitute = (node: unknown, atRoot: boolean): unknown => {
      if (!isPlainObject(node)) return node;
      if (!atRoot && !isRefOnly(node)) {
        const name = targets.get(canonical(node));
        if (name !== undefined) return { $ref: REF_PREFIX + name };
      }
      return mapChildren(node, (child) => substitute(child, false));
    };
    const before = canonical([...slots.map((slot) => slot.read()), ...defs.values()]);
    for (const slot of slots) slot.write(substitute(slot.read(), true) as SchemaObject);
    for (const [name, value] of defs) defs.set(name, substitute(value, true) as SchemaObject);
    const after = canonical([...slots.map((slot) => slot.read()), ...defs.values()]);
    if (minted === 0 && before === after) break;
  }

  mergeIdentical();

  // ── Drop defs nothing points at ────────────────────────────────────────────
  //
  // Only reachable defs are kept, and reachability is computed transitively: a def
  // referenced solely by another unreferenced def is unreachable too.
  const reachable = new Set<string>();
  const frontier: string[] = [];
  const seed = new Set<string>();
  for (const slot of slots) collectRefNames(slot.read(), seed);
  for (const name of seed) frontier.push(name);
  while (frontier.length > 0) {
    const name = frontier.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const value = defs.get(name);
    if (!value) continue;
    const nested = new Set<string>();
    collectRefNames(value, nested);
    for (const next of nested) if (!reachable.has(next)) frontier.push(next);
  }
  for (const name of [...defs.keys()]) if (!reachable.has(name)) defs.delete(name);

  // ── Give the minted defs names that read as documentation ──────────────────
  const finalNames = new Map<string, string>();
  const settled = new Set<string>([...defs.keys()].filter((name) => !provisional.has(name)));
  for (const [name, value] of defs) {
    if (!provisional.has(name)) continue;
    const base = deriveName(value);
    let candidate = base;
    let suffix = 2;
    while (settled.has(candidate)) candidate = `${base}_${suffix++}`;
    settled.add(candidate);
    finalNames.set(name, candidate);
  }
  applyRenames(finalNames);

  const renamed = new Map<string, SchemaObject>();
  for (const [name, value] of defs) renamed.set(finalNames.get(name) ?? name, value);

  if (renamed.size === 0) {
    delete copy.$defs;
    return copy as DedupedProtocol<T>;
  }
  // Sorted, so the emitted bytes depend on the schemas and not on the order the
  // walk happened to reach them.
  const table: Record<string, object> = {};
  for (const name of [...renamed.keys()].sort()) table[name] = renamed.get(name)!;
  copy.$defs = table;
  return copy as DedupedProtocol<T>;
}

/**
 * Resolve every `$ref` in `value` back to the schema it points at.
 *
 * The pass's contract stated as code: `resolveSchemaRefs(dedupe(p)) ` must equal
 * `resolveSchemaRefs(p)` byte for byte. Throws on a cycle rather than looping —
 * a recursive schema has no inlined form, and this exists to check the pass, not
 * to serve manifests.
 */
export function resolveSchemaRefs(value: unknown, defs: Record<string, object>): unknown {
  const walk = (node: unknown, stack: string[]): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, stack));
    if (!isPlainObject(node)) return node;
    const ref = node.$ref;
    if (typeof ref === 'string' && ref.startsWith(REF_PREFIX)) {
      const name = ref.slice(REF_PREFIX.length);
      if (stack.includes(name)) throw new Error(`recursive $ref: ${[...stack, name].join(' -> ')}`);
      const target = defs[name];
      if (!target) throw new Error(`dangling $ref: ${ref}`);
      const resolved = walk(target, [...stack, name]);
      const rest = Object.entries(node).filter(([key]) => key !== '$ref');
      // A `$ref` with siblings is legal in 2020-12; the siblings win on resolve so
      // the round trip of a node this pass never produces is still well defined.
      return rest.length === 0
        ? resolved
        : { ...(resolved as SchemaObject), ...Object.fromEntries(rest) };
    }
    const out: SchemaObject = {};
    for (const [key, child] of Object.entries(node)) out[key] = walk(child, stack);
    return out;
  };
  return walk(value, []);
}
