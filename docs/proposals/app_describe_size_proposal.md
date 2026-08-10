# Proposal: Keeping App Manuals Under the Offload Cliff

`describe('yaar://apps/studio-3d')` answers with 63,722 bytes of well-formed, deliberately
compact JSON. That is not a bug in the payload — it is a big app documented at a high
standard. It is still a failure in practice, because 63.7 KB is past the size at which the
Claude CLI stops delivering a tool result inline and replaces it with a pointer to a file
on disk — a pointer a monitor agent, which holds `yaar://` verbs and nothing else, cannot
follow. The agent gets a 2 KB preview and a dead end.

Three changes, in increasing order of behavior change:

> **1. The schema fold emits shared subschemas as `$refs`** (compiler; content-neutral).
> **2. Identical subschemas are hoisted into one `$defs` table per protocol** (compiler;
> content-neutral, needs a resolver at three named server seams).
> **3. ~~The verb doors get a size budget and degrade in YAAR's own vocabulary~~** —
> **superseded**. The protocol gets its own URI, and the index becomes what `list` *means*
> rather than a degradation a byte budget switches on (server). See §5.
>
> **Not proposed: trimming the prose.** The command descriptions were audited for this
> proposal and they are the product, not the padding — see §2.

**Status: all three have landed. Change 3 shipped in a different shape than first written —
§5 records what replaced it and why.**

- Change 1 — `reused: 'ref'` in `FOLD_ENTRY_SOURCE` (`protocol/fold-schemas.ts`).
- Change 2 — `protocol/dedupe-schemas.ts`, applied in `extract-protocol-dir.ts` so both
  readers and both roads (compile, deploy re-derivation) get it. The consumer audit in §4
  was carried out: `server/src/lib/schema-refs.ts` is the resolver, threaded into
  `command-signature.ts` and its three callers, and the per-command `describe` now returns a
  self-contained slice. Two adjustments to the plan as written, both recorded in the file
  headers: a descriptor's **top-level** schema is never hoisted (the iframe bridge validates
  by reading `params.properties`/`required` off it), and a slice **attaches** the defs it
  reaches rather than inlining them — inlining re-creates the duplication the pass removed
  and has no answer for a recursive schema.
- Reaching existing apps needed a third thing neither change contains: `COMPILER_VERSION`
  '19' → '20'. Both changes alter what the compiler *emits* and nothing an app's source
  *says*, so every staleness hash stays identical and no already-built
  `dist/protocol.json` would ever be recompiled — least of all studio-3d's, a
  user-installed app nobody is about to edit.
- Measured, recompiled end to end: studio-3d's protocol.json **53,549 → 41,814 B compact
  (-21.9%)**, 10 `$defs`, all 52 commands still rendering fully-typed signatures (no `$ref`
  reaching `renderSignature` as `any`). Seven apps gained a `$defs` table, not the "every
  bundled app is unchanged" this file first recorded from the count-based pass alone:
  `reused: 'ref'` shares by schema *instance*, which catches a const used twice inside one
  descriptor that no ≥120-byte repetition count would see (anima, ocr, word-lite 1 def each;
  image-edit and thesingularity-reader 2; slides-lite 6).
- One correction the recompile forced: zod hoists by instance identity with **no size rule
  of its own**, so promoting its table wholesale put `{"type":"number"}` behind a 25-byte
  pointer at 70 sites and `{"type":"boolean"}` at 32 more — bigger than the shape at every
  use, and worse documentation besides. `dedupe-schemas.ts` now inlines a minted def back
  when the def is no larger than one pointer to it (872 B, and the narrow test that cannot
  be wrong at any use count).
- **§4's "honest but marginal against the cliff" was right, and Change 3 closed it.** After
  changes 1 and 2 the describe payload still landed at **50,858 B against 63,722 B before** —
  *inside the bracket this session measured the cliff in* (51,211 B arrived inline, 63,722 B
  did not), so its delivery depended on an undocumented threshold in an unpinned CLI. Change 3,
  in the shape §5 now describes, takes it to **13.6 KB**.

---

## 1. The incident

Session `9a95f644` (2026-08-08): a monitor agent tried to learn studio-3d.

1. `describe('yaar://apps/studio-3d')` → 63,722 B. The Claude CLI's large-output handling
   replaced the result with `Output too large (62KB). Full output saved to: …/tool-results/
   toolu_….txt` plus a 2 KB preview.
2. The agent followed the pointer the only way it could — `read` with the absolute path —
   and got `No handler registered for URI: /home/…/tool-results/….txt`. Monitor agents
   hold the five `yaar://` verbs and no filesystem tools, **by design**; the escape hatch
   the offload assumes does not exist for any YAAR principal.
3. It retried the identical describe (same 62 KB, persisted again), then recovered
   piecemeal: `list` on the window for names, a brace-batched
   `describe('yaar://windows/studio-3d/commands/{addPrimitive,…}')` for details (43 KB —
   under the cliff, delivered inline), and at one point an empty-payload `invoke` of 14
   commands to farm the validation errors for signatures. It got there — five turns and
   ~150 KB of context later.

Two properties of the cliff make this worth a design rather than a shrug:

- **It is binary, not gradual.** Under it, a large result costs context. Over it, the
  result is *gone* for a verbs-only agent. There is no partial credit.
- **It is not ours and not pinned.** The threshold is the CLI's, version-dependent and
  undocumented. This session brackets it: 51,211 B arrived inline, 63,722 B did not. A CLI
  bump can move it silently in either direction. YAAR cannot read the threshold; it can
  only stay conservatively below where it has been observed.

> **Superseded on 2026-08-10 (issue #64).** The second bullet was wrong in its conclusion,
> though right about the bracket. The threshold is **50,000 characters** —
> `Math.min(tool.maxResultSizeChars, 50_000)`, which every unannotated MCP tool gets — and it
> is **not** `MAX_MCP_OUTPUT_TOKENS`, which YAAR had already raised to 131072 with no effect
> on it. A server can raise its own: `_meta["anthropic/maxResultSizeChars"]` on the tool's
> `tools/list` entry, honored up to a 500,000 ceiling
> ([docs](https://code.claude.com/docs/en/mcp#raise-the-limit-for-a-specific-tool)). YAAR
> declares 150,000 on its content-bearing tools — see `packages/server/src/mcp/result-size.ts`
> for why not 500,000 (a second, un-annotatable ~200,000-char budget across one message's tool
> results makes anything above it moot). §6's "detecting or pinning the CLI's threshold" entry
> goes with it. **Everything else in this document stands**: raising the cliff is not a licence
> to stop staying under it, and Change 3's two-doors shape is still the right answer for a
> payload YAAR composes itself.

Two doors crossed it in one session: `describe` on the app (63.7 KB) and `list` on the
window (79.9 KB — 62 resource-link rows, each carrying its full description).

## 2. Where the bytes are

The describe payload decomposes as:

| Component | Bytes | Verdict |
|---|---|---|
| `protocol` — command descriptions (52 commands) | 24,591 | **Signal.** Keep. |
| `protocol` — inlined param/return schemas | 23,818 | **~Half is mechanical duplication.** Target. |
| `protocol` — state descriptions | 2,620 | Signal. |
| `skill` (agent/SKILL.md) | 8,564 | Signal — correctly scoped (workflows, when-not-to-use). |
| identity, permissions, verbs, keys | ~4,100 | Overhead of being JSON. |

**The descriptions were read before being sentenced, and acquitted.** The largest
(`booleanOp`, 1,641 chars) is a dense behavioral contract: results stay editable, tools
are parked as re-evaluable hidden children, budgets, one-undo-step semantics. Siblings
document *differing defaults against each other* (`snapToSurface` defaults
`offsetMode: "normal"` vs `arrayOnSurface`'s `"bounds"`). This is exactly the anti-footgun
content that saves an agent three failed round trips, and the size distribution is sane —
37 of 52 commands are under 1 KB total. An app author *should* write like this. A platform
that punishes it has the incentive backwards.

**The params half is where the waste is,** because `fold-schemas.ts` inlines every Zod
schema with zero sharing:

- The 626-byte texture-slot sampler shape (`repeat`/`offset`/`rotation`/`center`/…)
  appears **5× inside `setMaterial` alone** (map, alphaMap, emissiveMap, normalMap,
  roughnessMap) and ~15× protocol-wide — roughly 9 KB restating one shape.
- The `{x,y,z}` vector triple appears **29 times** (~1.9 KB).
- `addNodes` (5,490 B of params) re-inlines the entire per-node schema — the 12-value
  geometry enum, the full light definition — that `addPrimitive` and `addLight` already
  carry.

Deduplication is lossless: nothing an agent needs disappears, and `map: {$ref: "#/$defs/
textureSlot"}` five times is arguably *better* documentation than five identical
200-byte blobs — it states "same shape" instead of making the reader diff them.

## 3. Change 1 — the fold emits `reused: "ref"` (compiler, one line)

Zod's `toJSONSchema` already does within-schema dedup: when the same schema *instance* is
referenced more than once, `{ reused: "ref" }` hoists it into `$defs` and emits `$ref`s.
Measured on a `setMaterial`-shaped toy: 1,687 B inline → 702 B with refs.

The change is one option in `FOLD_ENTRY_SOURCE`
(`packages/compiler/src/protocol/fold-schemas.ts`):

```js
const json = toolkit.toJSONSchema(value, { io: io, reused: 'ref' });
```

This only helps when the app author reuses one Zod const (`const textureSlot =
z.object(…)`) — which is precisely the authoring pattern that produces the duplication —
and only *within* one descriptor, because the fold calls `toJSONSchema` per
`params`/`returns`. Cross-command duplication (`addNodes` ⊃ `addPrimitive`) is out of its
reach, which is what Change 2 is for. Zod's generated names (`__schema0`) are opaque;
Change 2's post-pass renames them, and if Change 2 is deferred, they are acceptable at
descriptor scope where the def sits 200 bytes from its uses.

## 4. Change 2 — one `$defs` table per protocol (compiler post-pass)

After extraction — both readers, since the AST path serves JSON-literal apps that
hand-write the same duplication — a structural pass over the assembled protocol:

1. Walk every schema in `state.*.schema`, `commands.*.params`, `commands.*.returns`.
2. Hash each subschema; any that appears ≥ 2 times and is ≥ ~120 B (below that, the
   `$ref` costs what it saves) is hoisted into a protocol-level `$defs`.
3. Occurrences are rewritten to `$ref: "#/$defs/{name}"`. Names are derived, stable, and
   readable — property-fingerprint based (`vec3`, or `uri_repeat_offset…` truncated), not
   `__schema0` — because the primary reader is a model, and the name is documentation.
4. The pass is deterministic and idempotent; resolving every `$ref` back must reproduce
   the input byte-for-byte (property order included), and that round-trip is a test.

Estimated effect on studio-3d: the params half drops from ~24 KB to ~12–14 KB; the full
describe from 63.7 KB to ~52–54 KB. **That is honest but marginal against a cliff observed
at ~52–63 KB** — which is why this proposal does not stop at dedup. Dedup pays for itself
in context cost on *every* read of *every* schema-heavy app; the cliff itself is Change 3's
job.

**The load-bearing part is the consumer audit.** A `$ref` is only lossless if everything
that reads a protocol schema can resolve it. The readers, verified:

| Consumer | Today | Required change |
|---|---|---|
| `server/lib/command-signature.ts` — `renderType` | a `$ref` prop renders as `any` | resolve against the protocol's `$defs` before rendering; the resolver lives beside `renderType`, threaded a `$defs` argument by its three callers |
| `handlers/window.ts:796` (list door), `features/window/app-protocol.ts:336` (per-key describe), `agents/profiles/app-agent.ts:143` (app-agent prompt) | call `renderSignature` per command | pass the protocol `$defs` through |
| per-key describe / per-command slices | returns one command's `schema` self-contained | when slicing a single command out of the protocol, **inline its refs back** (or attach the referenced defs) — a sliced schema with a dangling `$ref` is corrupt |
| `defineApp` runtime validation | validates via the live Standard Schema (`~standard.validate`), never the JSON | none |
| `window.__yaar_manifest__` → iframe SDK | carries the manifest bytes back into the page for serving, not for interpretation | audit only |
| the model reading `describe` | reads JSON Schema | none — `$ref`/`$defs` is standard vocabulary |

The existing parity test (`fold-schemas.test.ts`: both readers produce identical manifests
for one app) must keep holding with the pass applied to both.

## 5. Change 3 — the protocol gets its own URI (server) — **shipped**

The principle stands: **no verb result should be allowed to cross the offload cliff, because
past it the failure is total for every YAAR principal.** What changed is the mechanism. This
section was first written as a **size budget** — one named threshold (40 KB) after which
`describe` and `list` silently degrade to an index. That is not what shipped, and the
argument against it is worth recording, because it was a good idea with one bad property:

> A budget makes the *same door* answer two different ways depending on a number the caller
> cannot see. An agent that receives an index has no way to know whether it is holding the
> whole manual or a summary of one, and a threshold tuned against one CLI's observed
> behavior is a constant that has to be re-tuned against the next.

The shape that ships instead gives the two answers **two doors**, and the index stops being a
degradation: it is what `list` already means everywhere else in the URI space.

```
describe('yaar://apps/{id}')                          identity + SKILL.md + permissions
                                                      + the *names* of state keys and commands
                                                      + the three doors below       ~13.6 KB
list   ('yaar://apps/{id}/protocol')                  the index: signature + first sentence
                                                      per command                   ~10.7 KB
read   ('yaar://apps/{id}/protocol')                  the manifest verbatim, opt-in  41.8 KB
read   ('yaar://apps/{id}/protocol/commands/{name}')  one command, self-contained,
                                                      brace-batchable: {a,b,c}
describe('yaar://apps/{id}/protocol')                 counts, bytes, and how to slice it
```

Four things this buys that the budget did not:

1. **Nothing is truncated behind a caller's back.** An agent that wants the whole manifest
   asks for it and knows it did. An agent that is *finding* the right command pays ~10 KB.
   The size of an answer is a consequence of which question was asked.
2. **§5's own asymmetry dissolves.** The budget version needed a doc-only carve-out at
   `yaar://apps/{id}/commands/{name}`, which collides head-on with the `INSTANCE_SUBPATHS`
   refusal in `handlers/apps/register.ts`. Under `/protocol/`, `rejectInstanceSubPath` never
   fires and the existing invariant is untouched — and the meaning is sharper than the
   carve-out would have been: `apps/{id}/protocol/commands/{key}` is the *documentation of*
   a command (a property of the installed app, identical on every monitor), while
   `windows/{id}/commands/{key}` is the command as something that runs. That is the same
   installed-vs-running line the apps/windows split already draws, extended rather than
   punctured.
3. **No constant to defend.** There is no 40 KB in the code. The observation about the CLI's
   threshold stays in this document, where it belongs, instead of becoming a magic number
   that outlives the CLI version it was measured against.
4. **A false success went with it.** `extractIdFromUri` matches the first path segment and
   ignores the rest, so *every* unclaimed sub-path under `apps/` used to answer as the bare
   app — `read('yaar://apps/notes/protocol')` cheerfully returned the effective manifest.
   Claiming `/protocol` properly forced the terminal to refuse what no resource module owns.

**The window list door still needed the first-sentence rule**, and gets it from the same
helper (`lib/protocol-index.ts`): `list('yaar://windows/{id}')` was the incident's *other*
crossing at 79.9 KB, and one implementation now serves both doors. There it is a genuine
behavior change — the door used to carry every word of every description — justified by what
`list` is for. The full text is one `describe` away at the per-command URI each row names.

First-sentence extraction is not quite the naive rule the budget version proposed. Cutting at
the first `.` followed by whitespace truncates "Applies a boolean operation, e.g. union or
subtract" to five words, and a length floor (believe a period only after 40 chars) throws away
legitimately short opening sentences. The discriminator that works is the *token* the period
is attached to: one or two letters, or already containing a period (`e.g`, `i.e`, `Dr`, `U.S`)
means abbreviation. Measured over studio-3d's 52 commands, **51 opening sentences survive
verbatim** and one hits the 220-char cap.

### Measured, end to end

Measured through the real `describeApp` / renderers against studio-3d's real
`dist/protocol.json`. The `describe` rows are the facts payload, so the ~4 KB handler
envelope (`verbs`, `invokeActions`, `subPaths`) is excluded from both columns.

| | before | after |
|---|---|---|
| `describe('yaar://apps/studio-3d')` — facts | 50,858 B | **10,314 B** |
| ↳ of which `agent/SKILL.md` | 8,730 B | 8,730 B — now 85% of the answer |
| `list('yaar://apps/studio-3d/protocol')` | — | 10,707 B |
| `read('yaar://apps/studio-3d/protocol')` | — | 41,814 B |
| `list('yaar://windows/{studio-3d}')` | 79.9 KB | ~10 KB |
| app agent `describe` (index inline) | 50,858 B | 18,937 B |

The second row is the one to read twice: what is left of `describe` is almost entirely the
file the app's author hand-wrote. The generated half no longer scales this door at all.

The app agent's door is the one place the index ships inline rather than behind a URI, and
the reason is containment, not size: an app agent holds four scoped tools and no `read` verb,
so a pointer it cannot follow is the same dead end this whole document is about. Its spelling
of the per-command read is a new `command` param on the same tool.

### Where it lives

- `handlers/apps/protocol-resource.ts` — the resource; `paths.ts` gains `parseAppProtocolPath`.
- `handlers/apps/register.ts` — dispatch order, and `rejectUnhandledSubPath`.
- `lib/protocol-index.ts` — `firstSentence` / `commandRow` / `buildProtocolIndex`, shared with
  the window list door.
- `features/apps/describe.ts` — `names` for the verbs door, `index` for the app agent's tool.
- `lib/command-signature.ts` — `renderPayloadExample` split out of `renderInvokeExample`, so
  the two vocabularies share the literal param keys instead of spelling them twice.

## 6. Deliberately not proposed

- **Trimming studio-3d's prose.** §2. Also: studio-3d is a user-installed app; the
  platform fix must work for the next 50-command app, not edit this one.
- **Giving monitor/app agents a filesystem read to follow persisted-output pointers.**
  The verbs-only surface is the containment model; the session-log directory holds every
  agent's history. The fix is to stay under the cliff, not to tunnel past it.
- **Changing the compact-JSON threshold.** `COMPACT_JSON_THRESHOLD`
  (`handlers/utils.ts`) already solved the indentation half of this problem and its
  rationale stands.
- ~~**Detecting or pinning the CLI's threshold.**~~ **Retracted** — see the note in §1. The
  threshold is 50,000 chars and a server may declare its own; YAAR does, in
  `packages/server/src/mcp/result-size.ts`.

## 7. Tests and exit criteria

- **Compiler:** dedup-pass unit tests — idempotence, no dangling `$ref`, resolve-back
  round-trips byte-for-byte, stable def naming across rebuilds; the two-reader parity
  case extended to a fixture with shared Zod consts *and* a JSON-literal app with
  hand-duplicated shapes.
- **Server:** `renderType`/`renderSignature` over `$ref` params resolves (not `any`) and
  per-command slices are self-contained (`tests/schema-refs.test.ts`); the summary rule and
  the row renderers (`tests/protocol-index.test.ts`); the doors themselves against a real
  on-disk fixture app — each verb's answer, a self-contained per-command read, the refusals,
  and the two invariants the split had to not break (`tests/app-protocol-doors.test.ts`).
- **Exit criterion, the one that matters:** the incident replayed —
  `describe('yaar://apps/studio-3d')` from a monitor agent — arrives inline with no
  `persisted-output`. **Met**: 10,314 B, a fifth of the lowest inline delivery this session
  observed, and it no longer grows with the app's schemas at all. Still worth replaying live
  against studio-3d before this is called closed; the numbers above are measured off its real
  `dist/protocol.json` through the real renderers, not through a running monitor agent.
