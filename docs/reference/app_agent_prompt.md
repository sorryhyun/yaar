# How an App Agent Gets Its Prompt and Tool Descriptions

**Source:** `packages/server/src/agents/profiles/app-agent/index.ts`, `packages/server/src/mcp/app-agent/index.ts`, `packages/server/src/agents/system-prompt.ts`, `packages/server/src/agents/profiles/turn-options.ts`

This covers the *common* app-agent tier: the one persistent agent per `(monitor, app)` pair,
created on the first interaction with an app's window and reused after (`AppAgentRegistry`,
keyed `{monitorId}::{appId}`). Sub-agents are a different tier — their prompt is supplied by
the owning app at spawn time (see `docs/architecture/agent_tree.md`); nothing below applies
to them except the role prefix.

## The profile

Everything an app agent is told and allowed lives in one `AgentProfile`, built by
`buildAppAgentProfile(appId)` (`agents/profiles/app-agent/index.ts`):

```ts
{ id, description, systemPrompt, allowedTools, model, appStateKeys }
```

- **Built lazily, cached per app.** `AppTaskProcessor` builds it on the app's first turn and
  caches it per `appId` for the session (a profile depends only on the app, not the monitor).
  A deploy invalidates it (`retire.ts` → `ContextPool.invalidateAppProfile`) so the next turn
  rebuilds from the new files; the agent and its conversation survive, only the instructions
  change.
- **Applied per turn.** The prompt is passed as `systemPromptOverride` on every turn
  (`app-task-processor.ts` → `runAgentTurn`), never baked into the provider session.
- **Model** comes from `app.json`'s `agentType` via `resolveAgentModel` (`model-tiers.ts`):
  `haiku`/`sonnet`/`opus` map to Claude model ids, an unknown value passes through as a full
  model id, and the default is the Sonnet tier. Under Codex the tier is translated by
  `claudeModelToCodex`.
- **`appStateKeys`** — the sorted state keys from `protocol.json`, used for the automatic
  handoff snapshot prepended to a turn's prompt after a window remount.

## Prompt assembly, in order

The system prompt is a base plus appended sections. Which base is a per-app choice; the
appended sections apply to **both** bases (an app that ships its own prompt issues the same
tool payloads as a generic one, so replacing the base must not drop the mechanics):

1. **Base** — `agent/prompt.md` if the app ships one, otherwise
   `profiles/app-agent/prompts/generic-base.md` with `{{appName}}` substituted. The lookup
   (and the `app.json` `"agent": { "prompt": … }` path override, legacy fallbacks, and the
   deliberate retirement of `AGENTS.md` as a prompt source) is `AGENT_DOCS` in
   `features/apps/discovery.ts`.
2. **Payload-literals rule** (`profiles/prompts/payload-literals.md`) — always appended.
   The write-literal-characters / never-hand-escape contract for tool arguments.
3. **Storage sections — both, for every app.** The static app-scoped section
   (`prompts/app-storage.md`) plus a **generated** shared-storage section rendered from the
   app's own declared grants, so the verbs the prompt promises are the verbs the door
   admits. Every app agent holds its own tree and the commons, so both sections are
   unconditional; what varies is the generated half, which either lists what the app.json
   reaches beyond the commons or says plainly that it reaches nothing further. Appended at
   one site above the branch — they drifted apart once when only one was.
4. **Protocol manifest** — generated from the app's `protocol.json`: state keys (read with
   `query`), then command signatures rendered by `renderSignature` with the compiler-hoisted
   `$defs`, the same renderer `describe` answers with. The two headings name the verb for
   each namespace because a command name is invalid as a state key and vice versa.
5. **App Docs index** — only for apps that ship `agent/docs/*.md` topics
   (`features/apps/docs.ts`). One scent line per topic, generated from frontmatter and
   filtered to `audience: agent|both`; the bodies are never injected — the agent pulls one
   with `describe({ topic })` when its trigger fires. This is the docs tier's entire
   always-loaded footprint.
6. **App-authoring contract** — only for apps whose `app.json` bundles `yaar-dev` (today:
   devtools). Generated per build by `buildAuthoringContract()`: the `defineApp` entrypoint
   contract, the exact mount id (`APP_MOUNT_ID`), the link-handling handshake, and the
   design-token *brief* (`describeDesignTokensBrief()` — every token name, no values). These
   are compiler-owned facts, restated by the compiler so they cannot drift.
7. **Controllable apps** — rendered from `app.json`'s `controls`: the app ids this agent may
   pass as `appId` to describe/query/command, with auto-launch semantics spelled out.

### What is deliberately NOT in it

`assembleSystemPromptForRole` (`agents/system-prompt.ts`) returns an `app-` role's prompt
**verbatim**: no environment section, no provider-correction section, no scope section, no
installed-app roster, no global storage/mounts, no onboarding. App profiles are closed over
their own app context; the global environment belongs to orchestrator-tier agents.

## Tool descriptions

The toolset is fixed: `APP_AGENT_TOOL_NAMES` (`agents/profiles/types.ts`) — the four `app`
namespace tools (`query`, `command`, `relay`, `describe`) plus `messaging`'s
`direct_message`. Their descriptions are **static strings**, registered once:

- `query` / `command` — `APP_TOOL_DESCRIPTIONS` in `mcp/app-agent/index.ts`. These say
  nothing about storage on purpose: the modern MCP era builds a server per request, so a
  per-app description would need an appId resolution and a manifest read on every request.
  The storage conditional lives in the system prompt (step 3 above) — exactly one place
  decides whether an agent is told about storage.
- `describe` / `relay` — inline in the same file. `describe` answers with the same
  `describeApp` builder the verbs door uses, so one question has one answer shape.
- `direct_message` — `mcp/messaging/index.ts`.

Per-tool parameter descriptions (`appId`, `timeoutMs`, `stateKey`, …) are Zod `.describe()`
strings in the same registrations.

## How the profile reaches the provider

`turnOptionsFor(profile, providerType)` (`profiles/turn-options.ts`) is the provider-aware
half, used by every turn runner:

- **Claude** — `allowedTools` is passed to the SDK, and `sdk-options.ts` additionally derives
  *which MCP servers to connect at all* from the `mcp__{server}__` prefixes in that list, so
  an app agent's CLI process connects to the `app` and `messaging` namespaces and nothing
  else.
- **Codex** — `allowedTools` must be `undefined` (Codex cannot filter tools within a
  namespace); containment is carried at server granularity instead by `codexServerFilter`
  (`providers/codex/provider.ts`), which selects whole MCP namespaces per thread. The model
  is the mapped tier, never the Claude id.

## Assembled prompt template

The skeleton `buildAppAgentProfile` produces, in order. `{{…}}` is a generated value,
`⟨if …⟩` marks a conditional section, and `…` elides static prose that lives in the named
part file. Order is load-bearing in one place: the shared-storage section opens by
contrasting itself with "the app-scoped one above", so app storage must precede it.

```text
{{base}}                                  ⟵ agent/prompt.md if shipped, else
                                            generic-base.md with {{appName}} substituted

## Tool Payloads: write literal text, never escape sequences
…                                         ⟵ profiles/prompts/payload-literals.md, always

## App Storage                            ⟨always⟩
…                                         ⟵ app-agent/prompts/app-storage.md, static
                                            (names the storage:* override rule; the
                                            overriding commands themselves show up
                                            under Available Commands like any other)

## Shared Storage (`yaar://storage/`)
…
Your app.json reaches further into the same tree:   ⟨if grants beyond the commons⟩
- `{{grant.uri}}` — {{grant.verbs}}
…

⟨if protocol.json declares state⟩
## Available State — read with `query(stateKey)`, never `command`
- `{{stateKey}}`: {{description}}

⟨if protocol.json declares commands⟩
## Available Commands — run with `command(command, params)`
Signatures below are exact — `?` marks an optional param. …
- `{{renderSignature(name, descriptor, $defs)}}`: {{description}}

⟨if agent/docs/ holds topics with audience agent|both⟩
## App Docs — read with `describe({ topic: "name" })`
Reference topics this prompt deliberately does not carry. …
- `{{topic.name}}`: {{topic.description}}

⟨if app.json bundles yaar-dev⟩
## App Authoring Contract (generated by the compiler — authoritative)
### Entrypoint        ⟵ the defineApp contract, static prose
### Mount point       ⟵ interpolates {{APP_MOUNT_ID}}
### Links into an app ⟵ the openUrl / link_open handshake, static prose
### Design tokens
{{describeDesignTokensBrief()}}

⟨if app.json declares controls⟩
## Controllable Apps
You may drive these apps by passing their id as `appId` to describe/query/command:
- `{{controls[i].appId}}` (commands: {{…}}) (opens minimized)
Call `describe(appId)` first … control opens one for you …
```

Nothing is appended after this at turn time: for an `app-` role,
`assembleSystemPromptForRole` returns the profile prompt verbatim (see above). The only
per-turn addition lands in the *user* prompt, not the system prompt: the handoff snapshot
of `appStateKeys` prepended after a window remount.

## The toolset, verbatim

Fixed for every app agent — `APP_AGENT_TOOL_NAMES`. Full names as the model sees them are
`mcp__app__{name}` and `mcp__messaging__direct_message`. Descriptions below are the exact
registered strings (parameter descriptions are the Zod `.describe()` strings).

### `query`

> Query the app state. Pass a stateKey to read specific state, or omit for the app manifest.

| param | description |
|-------|-------------|
| `stateKey?` | State key to query (omit for manifest). |
| `appId?` | Target another app you are permitted to control (via "controls"). Omit to read your own app. |

### `command`

> Send a command to the app. Specify the command name and optional parameters.

| param | description |
|-------|-------------|
| `command` | Command name to execute. |
| `params?` | Command parameters |
| `appId?` | Target another app you are permitted to control (via "controls"). Omit to drive your own app. |
| `timeoutMs?` | How long to wait for the app to respond. Defaults to 30s; raise it (max 180s) for commands that do real work, like a compile or a deploy. |

### `describe`

> An app's manual — its SKILL.md if it ships one, plus an index of its protocol: every
> state key and every command's call signature with its opening sentence, and an index of
> its topic docs when it ships any. Pass `command` to get one command in full instead,
> with its complete parameter schema — that is the door to use when a signature leaves
> you unsure, not a second full describe. Pass `topic` to get one topic doc in full, by
> the name the index shows. Omit appId to describe your own app; pass appId to inspect
> another app you are permitted to control.

| param | description |
|-------|-------------|
| `appId?` | App to describe (omit for your own app). Other apps require "controls" permission. |
| `command?` | One command to document in full (name as it appears in the index), instead of the whole manual. |
| `topic?` | One topic doc to read in full (name as it appears in the docs index), instead of the whole manual. |

### `relay`

> Hand off a message to the monitor agent when the request is outside your app domain.

| param | description |
|-------|-------------|
| `message` | Message to send to the monitor agent |

### `direct_message`

> Send an addressed message to another agent or the user. Delivery is asynchronous
> (fire-and-forget) — the recipient processes it on its own turn; any reply comes back as
> a separate DirectMessage, so do not expect the recipient's answer in the return value.
> Targets: "monitor" (your monitor), "monitor:{id}", "app:{appId}", "window:{id}", "user"
> (a notification).

| param | description |
|-------|-------------|
| `to` | Target address: "monitor", "monitor:{id}", "app:{appId}", "window:{id}", or "user". |
| `message` | The message content to deliver. |
| `end_turn?` | If true, end your turn after sending (hand-off / delegation). If false or omitted, keep working after sending. |

Note the deliberate silences: `query`/`command` say nothing about storage (that lives in
the prompt, gated per app — see above), and none of the descriptions vary by app. The one
per-call document that *is* app-specific — a command's full parameter schema — is fetched
on demand via `describe({ command })`, not pushed into a description.

## Adjacent files that are *not* the app agent's prompt

| file | consumer |
|------|----------|
| `agent/hint.md` | the **monitor** agent's prompt (what it is told about the app) |
| `agent/SKILL.md` | whoever calls `describe` — a manual, returned on demand |
| `agent/docs/*.md` | nobody, until pulled — only the generated *index* enters the prompt (step 5); a body is fetched via `describe({ topic })`, `read('yaar://apps/{id}/docs/{name}')`, or as a file in a clone |
| `AGENTS.md` | coding agents editing the app's source; the runtime reads it for nothing |
