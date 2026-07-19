# Proposal: Shared Media Tree and Asset Import

**Status:** Landed (steps 1–5)
**Scope:** `packages/server/src/handlers`, `apps/devtools`, `apps/anima`, `apps/image-edit`
**Primary objective:** let an image produced in one app become a compiled-in asset of an app
built in another, without the bytes ever passing through a model context

## Problem

A user generates an image in `anima`, edits it in `image-edit`, and wants `devtools` to use it
as an asset in an app it is building. Today that request dead-ends, for three separate reasons.

**There is nowhere shared to put it.** `yaar://storage/{path}` and
`yaar://apps/{id}/storage/{path}` are two spellings of one tree — the second resolves to
`STORAGE_DIR/apps/{id}/{path}` (`handlers/apps/paths.ts:30`), a plain subtree of the first
(`storage/storage-manager.ts:39-45`). Per-app storage is not a separate volume; it is a
subdirectory distinguished only by URI spelling. Neither producer writes outside its own
subtree: `anima` saves to `yaar://apps/anima/storage/generated/…` and says so explicitly
(`apps/anima/src/appfiles.ts:1-11` — "*not* the shared `yaar://storage/` tree"), and
`image-edit` does the same (`apps/image-edit/src/store.ts:22-30`). Both nonetheless declare
the broad `yaar://storage/` permission, which they do not use for output.

**The consuming agent cannot reach it.** `ResourceRegistry.execute()` has exactly one gate —
`access === 'session-principal'` (`handlers/uri-registry.ts:210`) — which no storage handler
sets, and `requirePermission` is called only from `http/routes/`. So app.json `permissions`
are an **iframe-only** construct that agents never touch, and the real boundary for agents is
the tool allowlist. The monitor agent holds the verb tools and can reach the whole tree. The
`devtools` app agent holds none of them: it has `query`/`command`/`relay`/`describe` only, and
its storage is forced through `scopedAppStoragePath` (`handlers/apps/paths.ts:51`) against an
appId taken from its own window, which it cannot name or forge. That confinement is one of the
cleanest invariants in the system and is worth keeping.

**There is no primitive for moving bytes.** Storage `invoke` actions are `write | edit | grep`
(flat) and `write | grep` (app-scoped). No copy, move, or attach. The workaround that emerged
is `image-edit`'s `exportDataUrl` command, whose own description reads "use when the result
must be passed to another app; the string can be large" (`apps/image-edit/src/protocol/io.ts:88-101`).
That is the shape to avoid: it routes ~550KB of base64 through an agent's model context.

Two prerequisite defects sit underneath the problem.

**The flat tree cannot hold binary.** The flat handler's write passes `payload.content` straight
through as a string (`handlers/storage.ts:150`), while the app-scoped handler decodes
`encoding: 'base64'` first (`handlers/apps/storage-resource.ts:125`). A monitor agent writing a
PNG to `yaar://storage/…` today produces a text file containing base64 — silently corrupt, with
no error at any layer. Any shared-tree design is dead on arrival until this is fixed.

**`yaar://storage/` currently implies every app's private storage.** `isUriAllowed`
(`http/access.ts:130`) is plain prefix matching, and the namespace rewrite that gives ownership
teeth (`storageUriForPath`, `access.ts:255-317`) is wired only into the `/api/storage/*` route
(`http/routes/files.ts`), not into `/api/verb` (`http/routes/verb.ts:276`). So an app declaring
`yaar://storage/` can POST `/api/verb` with `yaar://storage/apps/other/credentials.json` and be
allowed. Thirteen bundled apps declare it. The comment at `access.ts:265-269` anticipates this
exact hole. This proposal does not fix that gap, but it depends on it being fixed — see
Prerequisites.

## Design

### 1. `storage/media/{producer}/…` — a reserved prefix, not a new namespace

Published artifacts land in `storage/media/`, keyed by producer:
`media/anima/2026-07-19T…-seed42.png`, `media/image-edit/logo-edited.png`, `media/agent/…`.

The prefix sits *outside* `storage/apps/`, so once the `/api/verb` rewrite lands, a declared
`yaar://storage/media/` permission grants exactly the shared tree and nothing else. Producers
and consumers narrow their current broad `yaar://storage/` to it, and the permission line in
app.json starts meaning what it says.

A dedicated `yaar://media/` namespace was considered and rejected: prefix permissions already
express the grant, so a new scheme would need its own handler registration, `storageUriFor`
mapping, and frontend URL spelling for no added enforcement power. Per-file capability grants
were also rejected — YAAR's access model is prefix permissions plus role tiers, and a one-off
ticket system would be a second model to maintain against a threat that is not one (everything
reaching `media/` is either the user's deputy or an app the user installed with a visible
permission line).

Relocating `storage/apps/` out of the flat root is explicitly *not* proposed. The aliasing is
deliberate and documented (`access.ts:269-281`), agents benefit from one tree, and the monitor
agent's reach over it is intended. What is worth adding is documentation: `media/`, `temp/`, and
`files/` as named reserved prefixes in the storage handler description and the monitor prompt.

### 2. Two server changes

**`encoding: 'base64'` on the flat write** (`handlers/storage.ts`), mirroring
`storage-resource.ts:125`. Roughly five lines. Without it the monitor agent cannot produce a
valid PNG in `media/` at all.

**`action: 'copy'` with a `from: <yaar-uri>` field**, on both storage handlers. This is the
missing primitive: it moves bytes server-side without them entering a model context. The monitor
copying anima's output into `media/` becomes one cheap tool call instead of a base64 round-trip
through the transcript. The access check composes existing rules rather than adding policy — the
caller must be able to `read` the `from` URI under whatever rules already bind it (everything,
for the monitor; the declared permission list, for `/api/verb` callers).

### 3. `listMedia` / `importAsset` as devtools protocol commands

Implemented **in the iframe**, not as new agent tools:

- `listMedia({ prefix? })` — the iframe lists `yaar://storage/media/…` with its own token and
  returns names, sizes, and URIs. Discovery for a confined agent, with no verb tool.
- `importAsset({ from, to, recompress? })` — the iframe fetches the bytes (covered by its
  declared `yaar://storage/media/` permission at the access chokepoint), optionally recompresses
  to WebP via `OffscreenCanvas` — the same trick `packages/frontend/src/lib/uploadImage.ts`
  already uses, and a direct attack on the +33% base64 tax — then saves into its own scoped
  project storage via the `encoding: 'base64'` write path `anima` already exercises. Returns the
  written path and a suggested `import` line.

The security argument is the point of this shape. The agent gains **no new authority**: it asks
its own app to do what that app's declared, user-visible permissions already allow, through a
named command that appears in `dist/protocol.json` and is therefore auditable. This is precisely
how compile and deploy already work — the agent does not hold `yaar-dev`, the iframe does, gated
by `requireBundle` on its token (`access.ts:216-247`), and the agent drives it via `command()`.
Asset import gets the same shape, and app-agent confinement is untouched.

The alternatives, for the record:

| Mechanism | Verdict |
|---|---|
| `relay` to the monitor agent | Works once `copy` exists; keep as the escape hatch. But it is fire-and-forget (`mcp/app-agent/index.ts:379-396`), puts a second agent turn in the latency path, and makes the IDE's core workflow depend on another agent's cooperation. |
| A new scoped agent tool (`import`) | Expands the app-agent capability surface and needs its own grant model. Do not put the first hole in `scopedAppStoragePath` when a hole-free route exists. |
| `controls`-mediated pull from the producers | Returns bytes through the agent's context — the exact anti-pattern — and requires booting a WebGPU diffusion app to read a file. Rejected. |

### 4. Embedding stays build-time

`import art from './assets/art.png'` resolves to an inlined `data:` URI via `assetDataUrlPlugin`
(`packages/compiler/src/plugins.ts:454-468`). This is already house doctrine:
`apps/devtools/AGENTS.md:199` reads **"Import the file. Do not fetch it from storage,"** because
the preview runs under a throwaway principal and a storage-backed asset can 404 in preview and
work after deploy, or the reverse.

The full path is verified to work end to end: `importAsset` writes into project `src/assets/` →
the compiler inlines it → `syncDir` carries `src/assets/*` binary-safely into `apps/{id}/src/`
(`features/dev/deploy.ts:41-53`) → later recompiles still find it → the shadow-git snapshot
versions the asset with the code, so deploy's destructiveness is covered.

Note that `dist/` is wiped on deploy and only `index.html` plus `.build-manifest.json` are
copied (`deploy.ts:344-357`). There is no middle ground: an asset is either inlined in the
single HTML file or fetched at runtime. Nothing ships beside the bundle.

**Budget.** A 512×512 PNG at 300-500KB becomes 400-670KB inlined, well under the 5MB compiler
warning; with WebP recompression, more like 100-250KB. Roughly four to six sprites is the sweet
spot and ~2MB of raw assets the practical ceiling, past which editor round-trips on a multi-MB
`index.html` get unpleasant.

**Large-asset fallback:** runtime fetch from the *deployed app's own* storage, not from `media/`
— no dangling reference when the user prunes `media/`, no extra permission line, and `media/`
stays a staging area rather than a runtime dependency of shipped software. For v1, document the
pattern and lean on a monitor `copy`; do not build machinery.

### 5. UX

One new noun — "shared media" — and no new gestures.

1. **Producers** get a "Publish to media" button and a matching protocol command, so the user can
   also just say "publish the third one" and have it be a single call.
2. **Devtools:** the user says *"use the dragon image I made in anima as the loading screen."*
   The agent runs `listMedia` → confirms → `importAsset` → adds the `import` → compiles. If the
   image was never published, the recovery path is explicit rather than a dead end: publish it,
   or relay to the monitor to copy it over.
3. **Monitor-mediated** (and the lazy path): the user tells the desktop "take the image from
   anima and use it in the app devtools is building." The monitor runs `copy` into `media/`, then
   `direct_message` to `app:devtools` naming the URI. One sentence, two cheap calls, no bytes in
   context.
4. **Drag-and-drop** (later, not v1): `uploadImage.ts` already intercepts external file drops and
   writes `storage/temp/`; routing those to `media/uploads/` gets OS drag-in for free. Cross-*iframe*
   drag between app windows is genuinely hard with isolated iframes and is out of scope.

Flow 2 is the one the scenario names and should be flawless. Flow 3 is the one users will
discover first. Flow 1 is what makes both deterministic.

## Migration

Additive; no data moves.

- **anima / image-edit** keep their app-scoped galleries exactly as they are — existing stored
  images stay put and readable. Each gains a `publish` command pointed at `media/{appId}/…`.
  Narrowing app.json from `yaar://storage/` to `yaar://storage/media/` needs a one-time check
  that nothing else in either app relies on broad storage; their save paths do not, but neither
  app was exhaustively audited.
- **devtools** gains two protocol commands. The protocol-shrink gate (`deploy.ts:259-288`) does
  not fire on growth. One `AGENTS.md` paragraph teaches `listMedia`/`importAsset` and the
  not-yet-published recovery script.
- **The thirteen apps declaring `yaar://storage/`** are the migration surface of the `/api/verb`
  fix, not of this proposal — but this gives that fix its landing zone: apps that declared broad
  storage in order to share files re-declare `yaar://storage/media/` and lose nothing legitimate.
- Deprecate `exportDataUrl` in favour of `publish` once this lands.

## Prerequisites and ordering

1. ~~**`/api/verb` namespace rewrite**~~ — **landed.** The rewrite went into `requirePermission`
   itself rather than the verb door, so every caller of the gate shares it and the two spellings
   cannot disagree; grants are canonicalized alongside targets, and a traversing storage URI is
   refused. `media/` is now enforceable as a boundary.
2. ~~**`encoding` + `copy`** on the storage handlers~~ — **landed.** Both live in
   `handlers/storage-bytes.ts`, shared by the flat and app-scoped handlers. `copy` reads through
   `Bun.file().arrayBuffer()` rather than `storageRead` (a *presentation* read that renders PDFs
   and stringifies text). Malformed base64 is rejected rather than silently truncated. At
   `/api/verb`, a `copy` also checks `read` on its `from` URI — the write gate covers only half
   of it, and without the second check "write my own storage" would have become "read anything".
3. ~~**`listMedia` / `importAsset`** in devtools~~ — **landed**, in the iframe as designed. An
   import with no recompression is a server-side `copy`, so the bytes do not enter the iframe
   either; with recompression they are re-encoded to WebP and kept only if that came out smaller.
4. ~~**`publish` commands** and permission narrowing~~ — **landed.** anima and image-edit each
   gained a `publish` command *and* a toolbar button, and both narrowed `yaar://storage/` to
   `yaar://storage/media/` (neither used the broad grant for anything else). devtools narrowed
   too. `exportDataUrl` is marked deprecated in its own description.
5. ~~Monitor prompt note on reserved prefixes~~ — **landed** in `profiles/shared-sections.ts`,
   alongside `copy` and `encoding: "base64"` usage. Routing OS drops to `media/uploads/` is
   still open, and still explicitly not v1.

## Failure modes

1. **Bytes through model context** — the standing anti-pattern. Every path above is designed so
   base64 moves iframe↔server or server↔server only. Worth enforcing culturally, not just
   structurally.
2. **Silent binary corruption on the flat tree** — exists *today*. If step 2 is skipped, the
   monitor flow produces valid-looking, unreadable PNGs with no error anywhere.
3. **Step 1 never lands** — `media/` still fixes discoverability and the devtools flow, which is
   an acceptable interim, but it is not a security boundary until then.
4. **Bundle bloat** — an agent that learns `importAsset` will happily inline a 4MB photo.
   `importAsset` should warn above ~1MB post-recompression; `AGENTS.md:212` already carries the
   budget language and needs only the runtime-fetch escape appended.
5. **`media/` as an unbounded junk drawer** — no quota, no GC. The storage app can browse it,
   which is enough for v1.
6. **Request body limits** — `importAsset`'s write sends a multi-MB base64 body through
   `/api/verb`. Whether a server-side cap exists, and where it bites, was not verified; chunked
   write is the fallback if it does.

## Summary

One shared prefix (`storage/media/`), one new storage action (`copy`) plus a base64-write bugfix,
and two devtools protocol commands implemented in the iframe under permissions it already holds.
No new agent tools, no new namespace, no weakening of app-agent confinement, and the bytes never
touch a model context. Build-time `import` remains the embedding mechanism, with own-storage
runtime fetch as the documented fallback for assets too large to inline.
