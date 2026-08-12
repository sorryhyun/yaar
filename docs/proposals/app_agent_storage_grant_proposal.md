# Proposal: Gate the App Agent's `storage:*` Built-ins on a Declared Permission

> **Status: implemented.** Three things landed differently than written, and each is corrected
> in place below:
>
> 1. **Two layers, not three.** §5c's per-app tool description was **dropped**, not deferred.
>    Documenting the door in `query`/`command`'s descriptions and in the prompt is two sources for
>    one conditional; the prompt already describes the door in full and is built once per agent, so
>    the descriptions now mention storage *nowhere* — for a declaring app either. That deletes
>    Phase 3 entirely, along with the memoization and the legacy-freeze caveat it needed.
> 2. **`query`'s relative reads are gated too**, not just the three commands. §5d called the
>    `command` interceptor the one behavioral edit; that would have left `query("storage/x")` — and
>    `query("storage")`, which falls through to a listing — fully open, making the gate cosmetic
>    for reads. Both interceptors ask the predicate. `query("yaar://storage/…")` is unchanged: the
>    commons is granted for being an app, and `authorizeSharedStorage` already refuses the rest.
> 3. **Three of §8's four suites needed no change.** Only `app-agent-manifest.test.ts` asserted on
>    the gated behavior. `app-agent-shared-storage.test.ts`, `app-storage-scope.test.ts` and
>    `storage-read-directory.test.ts` exercise `permissionsAllow`, `scopedAppStoragePath` and
>    `storageRead` — pure helpers below the gate, which is why the gate did not disturb them.
>    New coverage is `src/tests/app-agent-storage-gate.test.ts`.
>
> Also worth recording against §4: the audit Phase 4 asked for found opportunistic use in
> `session_logs/` from three undeclared apps (session-logs, github, curious-library-vn) and **every
> instance was `storage:list`** — no undeclared app had written or deleted. github's was against
> `yaar://storage/`, which was already refused.

Every app agent holds three storage commands — `storage:write`, `storage:delete`, `storage:list` —
that no app declares, no app can decline, and that appear in no `protocol.json`. They are
intercepted inside the `command` tool (`mcp/app-agent/index.ts:477`) and return before
`resolveTarget` (`:522`), so they never reach the iframe at all.

This proposal makes them conditional: an app agent gets the built-ins **iff** its `app.json`
declares a covering `yaar://storage/…` entry. Everything else goes through app-authored protocol
commands, the way `apps/devtools/src/protocol/shared-tree.ts` already does it.

The conclusion is worth stating first, because it is not "the prompt lies":

> **Nothing in the prompt or the tool description is false today.** The defect is that the prompt
> hands the model a conditional it cannot evaluate — *"open to you only if your app.json declares a
> permission covering it"* — while never saying whether this app does. Falsehood is what the rule
> change **introduces** if the gate lands without the prompt and description changes. That is why
> the three layers are one change, not three.

---

## 1. What is unconditional today, and where each part is decided

`storage:*` splits on the spelling of `params.path` (`index.ts:484`), into three tiers with three
different gates:

| Argument | Tree | Gate |
|---|---|---|
| `"file.json"` (relative) | `storage/apps/{self}/` | **none** — rewritten by `scopedAppStoragePath` before anything is consulted |
| `"yaar://storage/shared/…"` | the commons | **none** — `permissionsAllow` returns `true` for every app before reading its list (`http/access.ts:282`) |
| `"yaar://storage/anything-else"` | the flat root | `authorizeSharedStorage` → `permissionsAllow` (`shared-storage.ts:92`) |

Only the third tier is governed. It is governed *well* — it calls the same `permissionsAllow` that
`POST /api/verb` calls for the iframe, deliberately not a second copy (`shared-storage.ts:27-30`).

Four of thirteen bundled apps declare a flat-storage permission:

| Declares `yaar://storage/` | Declares nothing |
|---|---|
| devtools, lab, search, storage | browser, browser-user, configurations, dock, market-apps, mcp-manager, memo, process-explorer, session-logs |

## 2. The two things actually wrong

### 2a. The prompt states a condition the model cannot evaluate

`agents/profiles/app-agent.ts:98-99` ends the app-storage section with:

> The shared `yaar://storage/` root is a **different tree**, named by URI rather than by relative
> path, and open to you only if your app.json declares a permission covering it.

The agent is not told whether its own app declares one. It finds out by trying and reading a
refusal. Meanwhile `buildSharedStorageSection` runs for *every* app (`:114`) — only the trailing
`extra` list is grant-derived (`:118-120`) — so an app holding nothing but the commons still gets a
full `## Shared Storage (yaar://storage/)` heading and four fully-general call examples.

### 2b. The capability is ungoverned, and one author has already routed around it in prose

`apps/search/agent/prompt.md:14`:

> **IMPORTANT:** Do NOT use `storage:*` commands (storage:list, storage:write, storage:delete).
> Those access Search's internal sandbox. Use `search` for shared storage; clone commands
> intentionally use that sandbox under `apps-source/`.

An author enforcing a capability boundary with a paragraph, because no switch exists. That is the
shape `shared-tree.ts:8-14` describes as the *intended* design — the agent asks the app to do what
the app's declared permission allows, through a named command — and search cannot get there.

## 3. The rule

> An app agent is exposed to `storage:write` / `storage:delete` / `storage:list` **iff**
> `sharedStorageGrants(appId)` is non-empty — that is, the manifest declares at least one entry
> under `yaar://storage/`, excluding the `yaar://storage/apps/` subtree.

Not exposed means all three of: absent from the system prompt, absent from the `command` tool's
description and parameter docs, and refused at execution.

Undeclared apps reach storage the way devtools reaches the shared tree: the iframe uses
`@bundled/yaar` (`appStorage`, `storage`) inside a command the author declares in `protocol.json`,
and the agent calls that command by name.

## 4. What the rule costs

**Nine of thirteen bundled apps lose the built-ins**, including their own app-scoped tree. This is
the aggressive reading and it is deliberate: a capability the author never declared is not one the
agent should hold, even when it is confined to the author's own directory.

**The commons becomes agent-unreachable for undeclared apps, while their iframes keep it.**
`permissionsAllow:282` is untouched, as is `SELF_GRANTS` (`http/iframe-tokens.ts:81`). The
asymmetry is the point: an iframe is app-authored code, an agent is a model.

**It partially re-opens an incident.** `shared-storage.ts:4-15` records why this door was built:
two app agents, asked to read a file the monitor had just written to the shared root, were silently
redirected to their own empty tree and answered "file not found" — a declared permission with no
door behind it. Nine apps lose that handoff again.

The mitigation is that the failure mode inverts. The incident was a *silent redirect*; this is a
*named refusal* that says which manifest line is missing and what to use instead. Honest failure was
the fix that incident asked for, and it survives.

**`apps/session-logs/agent/prompt.md:79` breaks.** It instructs
`command('storage:write', { path: 'reports/audit-YYYY-MM-DD.md', content })` against its own tree,
and session-logs declares nothing. It is the only in-repo instruction that will start failing;
SKILL.md and hint.md are clean across the other eight. But the base prompt advertised the built-ins
to all nine, so opportunistic runtime use would not appear in any file — see Phase 4.

## 5. Where the gate goes

### 5a. One predicate

`declaresSharedStorage(appId): Promise<boolean>` in `mcp/app-agent/shared-storage.ts`, defined as
`sharedStorageGrants(appId).length > 0`. That function already applies the right filter
(`:134-137`) and is already the thing the prompt renders from.

Its header currently reads *"Presentation only — {@link authorizeSharedStorage} is the gate, and
this list is never consulted to admit anything"* (`:124-126`). **That sentence becomes false and
must be rewritten in the same commit**, or a presentation helper silently becomes a gate that no
comment documents.

### 5b. Layer A — the system prompt

`APP_STORAGE_SECTION` is a module const (`app-agent.ts:86`) and `buildSharedStorageSection` is
always called. Both become conditional on the predicate.

⚠️ **The trap is recorded at `app-agent.ts:78-84`.** These sections must reach `prompt.md`-override
apps too — an override replaces the base prompt entirely, and the same two tools are issued either
way. A previous fix moved one section out of the generic branch and missed the other, leaving every
`prompt.md` app (devtools among them) never told that `storage/{path}` reaches its own tree, and
leaving the shared section's *"a **different tree** from the app-scoped one above"* pointing at
nothing. Apply the conditional at the one site that assembles both branches.

For a declaring app, `:98-99`'s dangling conditional should also be replaced with the concrete
grants — `sharedStorageGrants` already returns `{ uri, verbs }` and `buildSharedStorageSection`
already renders it for `extra`.

### 5c. Layer B — the tool description ⟨**dropped — see Status**⟩

`index.ts:438-445` hardcodes three sentences of storage documentation into the `command` tool's
description, and `:450` repeats it in the `command` parameter: *'Use "storage:write",
"storage:delete", or "storage:list" for app storage.'* Both must be built per-app.

**This is feasible.** `handleMcpRequest` wraps the entire dispatch — both protocol eras — in
`runWithAgentContext({ agentId, sessionId, monitorId, windowId, role })` (`mcp/server.ts:434`), so
`createServerForName` runs with `windowId` live and can resolve the appId exactly as the handlers
do at `index.ts:480`.

Two caveats:

- **Cost.** `getAppMeta` is uncached — `Bun.file().text()` + `JSON.parse` per call
  (`discovery.ts:493`) — and on the modern era `createServerForName` is the per-request factory
  (`server.ts:365`). Memoize the predicate by appId with a short TTL, or this adds a disk read to
  every `app`-namespace MCP request.
- **Legacy freezes it.** The 2025-era leg builds one server per `mcp-session-id` at `initialize`
  and reuses it. That is correct here: an MCP session belongs to one agent, hence one app. It does
  mean a manifest edit mid-session is not picked up until the agent reconnects — acceptable, and
  worth one sentence at the call site.

### 5d. Layer C — the execution refusal

Keep it even with A and B; a prompt is not a gate. Copy `direct_message`'s shape exactly
(`mcp/messaging/index.ts:107-112`): always registered, refused at call time with a message naming
the fix.

One difference in wording. `direct_message` tells the model to add `"messaging": "all"` to app.json;
that is right for a *monitor* agent reading the refusal. An app agent cannot edit its own manifest,
so the refusal should name the app's own protocol commands — which `describe` already lists — and
mention the manifest only as the author-facing note.

Reorder the interceptor (`:477-490`): resolve appId → predicate → refuse or proceed. Today
`namesSharedStorage(path)` splits before any check, so the app-scoped branch becoming gated is the
one behavioral edit.

## 6. Not in scope

**Search's inverted case.** Search declares `yaar://storage/`, so under this rule it *keeps* the
built-ins and its prose ban at `prompt.md:14` stays load-bearing. Solving it needs the opposite
knob — an author opt-*out*, e.g. `agent: { storage: "none" }` — which is a separate manifest field
with its own grant semantics. Named here so it is not mistaken for something this change delivers.

**The iframe side.** `SELF_GRANTS`, the commons in `permissionsAllow`, and every `POST /api/verb`
path are untouched. This proposal governs one MCP tool's built-in commands and nothing else.

**Foreign app storage.** `storage:*` has no spelling for another app's tree — the interceptor
refuses `args.appId` outright (`:478-479`) — so `capForeignAppStorage` and the `sharedOnly` ceiling
are unaffected.

## 7. Plan

**Phase 1 — predicate + refusal.** Add `declaresSharedStorage`, rewrite the `sharedStorageGrants`
header, reorder the interceptor, refuse. Behavior lands here; the prompt is now *wrong* for nine
apps, which is why Phase 2 is not optional and should be the same PR.

**Phase 2 — prompt.** Make both sections conditional at the shared assembly site. Replace the
dangling conditional at `:98-99` with rendered grants.

**Phase 3 — tool description.** Per-app description in `createServerForName`, plus predicate
memoization. Separable from 1–2 if the perf work needs its own review.

**Phase 4 — app fixups.** Edit `session-logs/agent/prompt.md:79` — either drop the line or expose a
`saveReport` protocol command in its iframe, which is the pattern this proposal wants to be the
norm. Before shipping, one pass over `session_logs/` for `mcp__app__command` calls with a
`storage:` prefix from the other eight apps, since prompt files would not reveal opportunistic use.

**Phase 5 — tests + docs.**

## 8. Tests

Existing suites that pin today's behavior and must change:

| File | What it pins |
|---|---|
| `tests/app-agent-manifest.test.ts:94` | prompt **contains** `command(command: "storage:list", …)` — now fixture-dependent; needs a declaring fixture plus a negative case |
| `tests/app-agent-shared-storage.test.ts:225` | verb charging (`storage:write`→`invoke`, `storage:delete`→`delete`) |
| `tests/app-storage-scope.test.ts:39` | `storage:list` with `path: ".."` cannot enumerate installed apps |
| `tests/storage-read-directory.test.ts:9` | the "cannot navigate storage" report that motivated `storage:list` |

New coverage:

- Undeclared app: no storage sections in the prompt, no storage sentences in the `command`
  description or parameter doc, and a refusal that names the app's own commands.
- Declaring app: all three unchanged, including the relative form.
- A declaration narrower than the root (`{ uri: "yaar://storage/reports/", verbs: ["read","list"] }`)
  exposes the built-ins but still refuses `storage:write` — the per-verb rule and the exposure gate
  are separate questions and must not collapse into each other.

## 9. Docs that go stale

- `packages/server/CLAUDE.md` — the Tools table row for `mcp/app-agent/`, and the "App Storage"
  framing wherever it asserts the built-ins are automatic.
- `agents/profiles/app-agent.ts` — the header rationale at `:78-84`, which currently explains why
  both sections are unconditional.
- `mcp/app-agent/shared-storage.ts` — the module header's "What is not decided here" section
  (`:25-31`), which will now decide exposure as well as authorization.
- `docs/guides/app-development.md` and `docs/reference/app_protocol_reference.md` — any statement
  that an app agent has automatic storage access.
