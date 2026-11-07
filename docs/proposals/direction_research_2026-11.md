# Direction research: what would let YAAR jump forward (2026-11)

**Status:** research, not a design. Nothing here is implemented. Recorded 2026-11-07.

**Method.** A deep-research run on Opus 5.5 subagents: six web-search angles (generative-UI
standards, rival agent desktops, per-turn cost, agent memory, app ecosystems, provider SDK
changes) produced 78 claims; the top 18 were each put to three adversarial verifiers with
different lenses (facts, currency, does-the-inference-follow); a claim died on two refutes.
16 survived, 2 died. A synthesis agent wrote the report in §2 from the survivors, and a critic
agent wrote §3. §1 is the maintainer-side verdict after reading both and measuring this
checkout's own `session_logs/`, which answered the critic's first question and changed the
ranking.

## 1. Verdict

The leap is to become the **desktop-class host for MCP Apps**. The biggest internal win is
**making the Dev Tools loop cheaper**. Crystallization should wait for demand data.

### Host MCP Apps as a persistent `yaar://` window type

MCP Apps became the first official MCP extension on 2026-01-26 and is rendered by Claude,
ChatGPT, VS Code, Cursor, Goose, M365 Copilot and Gemini Enterprise; OpenAI now calls its own
`window.openai` bridge a compatibility alias. Both providers YAAR drives expose the pieces a host
needs (an alpha `ui://` resource read plus a model-free tool call on the Agent SDK; `mcpAppUi` on
Codex `mcpToolCall` items at a protocol version YAAR already binds). The draft spec dropped the
double-iframe requirement on 2026-11-04, leaving a cross-origin iframe with CSP, which is the
path YAAR's per-app-origin frames already take (`IframeRenderer.tsx` applies a subtractive
sandbox to cross-origin app frames; bundled same-origin apps are unsandboxed). What chat hosts
cannot do is keep these widgets open side by side, addressable and messageable. That is YAAR's
shape. Exporting YAAR apps outward did not survive verification as a general path (apps depend
on app storage, the fetch proxy and per-app agents); treat it as a narrow opt-in later.

### Attack the cost where it is: the Dev Tools loop

The critic's first question was how often flows repeat in YAAR's own logs. Measured on this
checkout (`session_logs/`, 247 directories, 121 with agent tool calls):

| Measure | Value |
|---|---|
| Agent tool calls | 13,389 |
| Made by the Dev Tools app agent | 67% |
| Made by monitor agents | 18% |
| Calls whose exact `(tool, command)` shape recurs in ≥5 sessions | 85% |
| Most common shapes | `editFile`, `readFile`, `previewCommand`, `previewEval`, `grep`, `compile` |

Repetition is high, but it is read/edit/preview/compile in coding loops. The content of each
step is the model's output, so there is nothing model-free to replay. On this machine the ceiling
for crystallization is small, and the verified literature agrees (prompt-keyed agent caches hit
0–17% on personal-agent traffic; mined macros offered to the model saved 6–12% of calls). The
lever is making those ~9,000 Dev Tools calls cheaper: return handles and server-side filtered
summaries instead of bulk file contents, and route read-only exploration to a cheaper, separate
fixed-prefix session rather than switching models mid-session (which breaks the prompt cache).

### Crystallization only after demand shows up

The idea is sound and the reload cache's failure is explained by its design: exact prompt hash,
session-specific window ids, and a hit that is only *offered* to the model. If non-dev app usage
grows, rebuild the key on `(appId, command, args-shape)` and let a hit run without a model turn.
Gate any learned memory on outcomes: adding every experience lowered scores in the studies
checked, and self-generated skills scored below no skills on Claude Code, Codex and Gemini CLI.

### Substrate risks

The auth policy for third-party harnesses tightened in February 2026 and was enforced in April.
YAAR's stock-binary, own-login, local model fits the stated carve-out, but that rests on one docs
page; document API-key auth as first class. For the Market, 2026's extension-store failures were
on the update path, not submission: re-scan every version and diff the app agent prompt and
granted permissions on update.

### Not verified, do not act on without checking

The Codex Haiku-equivalent model name, the two-tier Haiku 5.5 pricing, and plan API credits are
weakly sourced in §2. The research skipped on-device/in-browser LLMs as a router despite YAAR's
WebGPU ML runtime, and gave no answer on cold-start latency.

## 2. Synthesized report (Opus, from verified claims)

*Deep-research synthesis, 2026-11-07. Claim IDs (C01–C18) refer to findings that survived three-vote adversarial verification. Corrections from the verifiers are applied throughout.*

### Verdict

YAAR does not need a better UI generator. It has two problems to fix. First, it pays a frontier-model turn for work the desktop already knows how to do. Second, it is an island while the industry has settled on almost the same app container YAAR built. Both first-party labs showed that regenerating UI on every request runs into persistence and latency limits. Anthropic called Imagine with Claude a five-day "feasibility study" with simulated files. Google admits its generative UI "can take a minute or more", and it answered latency with faster models, not reuse (C09). Meanwhile MCP Apps has become the cross-vendor iframe-widget format (C01). The bet that compounds with what YAAR already has is in two steps:

1. **Now:** host MCP Apps as a first-class, persistent `yaar://` window type. This is bounded work and well supported by the evidence.
2. **Next:** build crystallization as routing that runs below the model. Key it on the typed `(appId, command)` protocol calls YAAR already logs. Promote a flow only when outcomes confirm it.

A cheap companion model and better auth and Market hygiene are supporting work, not the main event. The fully general "export every YAAR app to ChatGPT and Claude" pitch did not survive verification. Treat it as a narrow later phase.

### Ranked directions

#### 1. Make YAAR the desktop-class MCP Apps host (confidence: high, about 0.8)

**What it is.** Add a window type that renders any MCP Apps (SEP-1865, `io.modelcontextprotocol/ui`) widget from a server the user connected. Give it a `yaar://` address, persist it, and let the monitor agent message it, just like a native app window. Chat hosts show these widgets inline and let them scroll away. YAAR would keep them open as windows next to each other.

**Evidence.**
- **The standard is settled.** MCP Apps became the first official MCP extension on 2026-01-26 and is the only Stable version ([blog](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/), [ext-apps](https://github.com/modelcontextprotocol/ext-apps)).
- **Hosts render it:** Claude web and desktop, ChatGPT, VS Code, Goose, M365 Copilot, Cursor 2.6, and Gemini Enterprise (Enterprise only, not consumer Gemini) (C01).
- **OpenAI is moving to it.** OpenAI calls `window.openai` "compatibility aliases" and says new UI should use the shared bridge ([OpenAI](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt)).
- **Both providers already expose the pieces a host needs** (C03):
  - Agent SDK 0.3.280+ has alpha `readMcpResource()` for `ui://`, gated on `mcp_read_resource_v1`.
  - `mcpServerStatus()` exposes tool `_meta.ui`.
  - An `mcp_call` control request runs a tool without a model turn.
  - Codex `mcpToolCall` items carry `mcpAppUi {resourceUri, preferredModelDisplayMode}`, with HTML fetched via `mcpServer/resource/read`. YAAR's bindings at `CODEX_MIN_VERSION` 0.145.0 already include both.
- **The framing barrier just dropped.** The draft spec removed the required double-iframe proxy on 2026-11-04 (PR #717). It now asks only for a different-origin iframe with `allow-scripts allow-same-origin` and CSP headers derived from `ui.csp` (C02, [draft spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx)).

**Why it fits.** YAAR's per-app `<appId>.localhost` origin probably already satisfies the draft's framing rules once it adds the sandbox flags and the CSP header. The draft's new app-registered View tools, bridged to WebMCP, are the closest match in the spec to `protocol.json` commands (C02). A widget's `tools/call` maps onto `mcp_call` or `mcpServer/tool/call`, so clicks in the widget cost no model turn. That is a small model-free win in its own right. The 5-verb surface absorbs it naturally: `describe` on a widget window returns its tool schema, and `invoke` proxies to the bridge.

**What YAAR still has to build** (C03):
- The host bridge: the `ui/initialize` handshake with `hostContext` (theme, CSS variables, dimensions, locale) fed from `tokens.ts`; delivery of tool input and results; display-mode and size handling.
- CSP and permissions enforcement.
- Saved tool results, so a widget comes back after a reload as a live window rather than an empty shell.
- A deliberate connect-a-server flow with OAuth. Today third-party servers reach agents only through inherited CLI config.
- A fallback when the alpha capability is missing. `readMcpResource` is also refused on Remote Control and cloud lanes.

**What it displaces.**
- Hand-built Market integrations for services that already ship MCP Apps.
- Any temptation to adopt A2UI, which has no major consumer host, or AG-UI, which solves agent-to-frontend streaming and not YAAR's problem. Both are distractions.

**Risks.**
- Coverage is limited to spec-compliant widgets, not "the whole catalog".
- The Claude path depends on an alpha API.
- Third-party OAuth inside a local app is real work.
- Persistence is a YAAR feature you build. It does not come with the APIs.

**Later phase, low confidence (about 0.4): export.** Shipping YAAR apps to other hosts is not bounded (C01, C02). Apps depend on appStorage/appDb, the fetch proxy, shared signals, `yaar://apps/self` and per-app agents. Bundled apps are same-origin and unsandboxed. Export needs a remotely reachable server on the stateless 2026-07-28 core and an SDK shim. It strips out agent-driven features and conflicts with YAAR being local-only. If you do it, make it opt-in per app for self-contained apps only:
- turn proxied calls into direct fetches with generated `connectDomains`;
- check whether YAAR-allowed `unsafe-eval` and `blob:` scripts survive a stricter host CSP;
- target the non-deprecated `_meta.ui.resourceUri` key.

#### 2. Crystallization as routing below the model, keyed on typed protocol intent (confidence: medium, about 0.6)

**What it is.** Mine repeated sequences of verb and app-protocol calls from session logs. Key each one on a canonical intent taken from the typed call itself, `(appId, command, normalized-args-shape)`, not from prompt text. Replay a matched sequence deterministically, with schema-checked protocol calls and no model turn. Hand back to the agent on any mismatch. Promote the most stable flows into compiled, model-free apps through Dev Tools, with shadow-git rollback as the safety net.

**Evidence.**
- **Prompt-keyed caching fails on personal-agent traffic** (C06, [arXiv 2602.18922](https://arxiv.org/html/2602.18922v1)):
  - GPTCache-style caching hit 5.6–16.9%.
  - An APC-style baseline hit 0–12%.
  - Template fingerprinting hit 69.3% with only 48.1% precision.
  - The fix is a canonical (What, Where) key with parameters injected at run time.
  - The weak link is the intent classifier: 91.1% on 8-class MASSIVE, only 55.3% on the 20-class personal-agent set. This is the strongest argument for taking intent from typed protocol calls instead of classifying free text, and YAAR is unusual in having those calls.
- **Macros the model must choose save little** (C07). AWO (EPFL, not Microsoft as first reported; [arXiv 2601.22037](https://arxiv.org/html/2601.22037v2)) cut LLM calls 5.6–11.9%, about 15% of cost on AppWorld. Speculative Macro Commit found that open models "rarely select these mined macros", and exposing them as tools slightly worsened latency and accuracy ([arXiv 2609.03236](https://arxiv.org/pdf/2609.03236)). The large saving has to come from keeping the model out of the choice. Neither paper tested model-free apps, so this is an inference, not a measured result.
- **Plan caching pays only where tasks recur.** APC reports 50.31% lower cost and 27.28% lower latency on repetitive workloads, and weak gains where tasks rarely repeat (C06, [arXiv 2506.14852](https://arxiv.org/abs/2506.14852)). Scope the cache per app, where flows actually repeat.

**Why it fits.** The reload cache's near-zero hit rate comes from YAAR's own design (C06, third verifier):
- it uses an exact hash of the prompt and of session-specific window IDs;
- its fuzzy threshold of 0.85 requires the same trigger and the same window state;
- a hit is only *offered* to the model, which still pays the turn.

Rebuild it on protocol intent and let a hit run without the model. That makes the reload cache the first rung of crystallization instead of a separate system. Apps as folders plus Dev Tools already give you the last rung, the compiled app.

**What it displaces.**
- The current reload-cache key.
- The "offer mined macros as extra tools" variant of the proposal.
- Claude Code dynamic workflows as a substrate. They are not model-free: every step is a subagent turn. The script has no file or shell access. They exist only on the Claude provider (C08, [workflows](https://code.claude.com/docs/en/workflows.md)). Use them at most as a design reference for the schema-bound steps that need a model.
- Hook-based shortcuts. A PreToolUse hook cannot return a cached result, and it fires after the model has already spent its turn choosing the call (C15, [hooks](https://code.claude.com/docs/en/hooks.md)). Skipping a turn requires routing in YAAR *before* the provider is called.

**Related cheap win.** Have the verbs return handles or server-side filtered summaries instead of bulk contents. This works on both providers and directly addresses context bloat from bulk file reads. Anthropic's example of 150K tokens shrinking to 2K is illustrative, not a measured eval (C15, [code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)).

**Risks.**
- A wrong replay is worse than a slow turn, so the precision bar must be high.
- Coverage is unknown until it is measured on YAAR's own logs.
- Deterministic triggers need a user-visible "this ran without the AI" indicator and an undo.

#### 3. An outcome-gated experience compiler, proven by a replay benchmark (confidence: medium, about 0.55)

**What it is.** This is the intake pipeline that feeds Direction 2:
1. Extract candidate lessons and flows in the background.
2. Dedupe them and track helpful and harmful counters.
3. Promote a lesson to a short per-app skill, then to a crystallized flow, then to an app, but only after later sessions confirm it.

Scope memory per app and per monitor, as `yaar://` resources the user can inspect and edit. Quarantine anything derived from web or app content.

**Evidence** (C16):
- **The quality of the gate decides the outcome.** In Xiong et al., adding every experience dropped scores (16.75→13.05, 40.11→32.32). Oracle gating raised them to 38.50 and 51.00, but automatic evaluators gained less, and the weakest one fell below baseline ([arXiv 2505.16067](https://arxiv.org/html/2505.16067v2)).
- **Self-written skills hurt and small sets win.** In SkillsBench v4, curated skills added +16.6pp. Self-generated skills scored 8.1–11.5pp *below* no skills on the Claude Code, Codex and Gemini CLI harnesses. Two or three skills per task gained +19.0pp, and four or more only +10.1pp ([arXiv 2602.12670](https://arxiv.org/html/2602.12670v1)).
- **Incremental edits with feedback work.** ACE uses itemized delta updates, works without labels by using execution success, and degrades without reliable feedback ([arXiv 2510.04618](https://arxiv.org/html/2510.04618v1)).
- **Failures are useful input.** ReasoningBank gained more by also distilling from failed runs ([arXiv 2509.25140](https://arxiv.org/html/2509.25140v2)).
- **Gains are hard to measure.** Skill Issue could not separate a 4.9pp gain from noise at single-repository scale ([arXiv 2609.12742](https://arxiv.org/abs/2609.12742)).

**Why it fits.** Generic agents lack the outcome signals YAAR already logs:
- **Strong signals:** protocol command success or failure, and Dev Tools rollbacks as explicit failures.
- **Weak, untested proxies:** "kept the window" and "didn't re-ask", because windows persist by default. Weight these low.

YAAR already disables both providers' native memory (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in `packages/server/src/config/providers/claude.ts`, and the `memories` feature off in `codex.ts`), so there is no hidden build-up to clean up first (C17). Serve the store through YAAR's own verbs so it is the same on both providers. The Messages-API `memory_20250818` tool is not something the CLI/SDK path lets you register (C17). Codex's idle-time, quota-aware extraction that skips external-content chats is a good scheduling template ([Codex memories](https://learn.chatgpt.com/docs/customization/memories?surface=app)).

**What it displaces.** Any "agents write their own skills" feature, and any claim that "it gets better the longer you use it" that has no measurement behind it.

**Risks.**
- A user-profile memory raises sycophancy (up to +45% for Gemini 2.5 Pro, [arXiv 2509.12517](https://arxiv.org/abs/2509.12517)). Keep this memory procedural, not about the user.
- Injection is real (MINJA: 98.2% injection rate, 76.8% attack success, [arXiv 2503.03704](https://arxiv.org/html/2503.03704v5)). MINJA assumes a memory bank shared across users, which mostly does not apply to single-user local YAAR, but Market-shipped lessons would reopen that risk.
- Prerequisite: build the replay benchmark from `session_logs/` first. It has to be large, or you will be shipping noise.

#### 4. A Haiku-class companion as router and read-only prefetcher (confidence: medium-low, about 0.45)

**What it is.** Run a separate cheap session, not a mid-session model switch. It watches window and protocol events and does three things:
- canonicalizes intents for Direction 2's cache;
- proposes delegation to app agents;
- prefetches side-effect-free reads (`describe`, `list`, protocol state reads) so they are ready when the main agent asks.

It does not author UI, and it does not speculatively commit visible window opens.

**Evidence.**
- **Price.** Haiku 5.5 is $0.10/$0.50 per MTok under 100K tokens and $0.50/$2.50 above (C10, [pricing](https://platform.claude.com/docs/en/about-claude/pricing)). Cache reads are about 1/20 of Opus 5.5 cache reads, not 1/40. Running on every turn, the companion costs roughly 5% of the main agent's input cost under 100K and about 25% over it. That is cheap but not trivial. YAAR sessions have a median peak of 81K and 122 sessions above 150K, so the companion needs a rolling window.
- **No Haiku tier on Codex.** It maps to gpt-6-luna.
- **Speculation buys latency, not cost.** SMC cut latency 18.59% on τ²-Bench Telecom, but only 10.23% against plain Speculative Actions. It is safe only where side effects run on a snapshot (C07, [arXiv 2510.04371](https://arxiv.org/abs/2510.04371)).
- **Cache rules.** Never switch models or tool sets mid-session; delegate to a separate session instead (C11, [Claude Code caching lessons](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/)). YAAR's `turnFingerprint` reopens the stream whenever `systemPrompt`, `allowedTools` or `model` change, so the companion must be its own fixed-prefix session.

**What it displaces.** The vaguer "always-on model that proposes delegation" proposal, narrowed to a measurable job.

**Risks.** The value is mostly latency, and it depends on Direction 2 existing.

#### 5. De-risk the substrate: auth posture, Market update path, cache TTL (confidence: high on the facts, these are maintenance)

- **Auth** (C05, [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md)). YAAR's model (stock binary, the user's own `claude login`, local, no resale) fits the stated carve-out for running unmodified Claude Code. It is not in direct conflict with the policy. The exposure is that the policy keeps changing: tightening in February 2026, enforcement against third-party harnesses in April, and a planned separate credit paused in June.
  - Keep these boundaries: never collect or broker tokens; never let one user's subscription serve another's requests in Market, remote or shared modes; never brand the product "Claude Code".
  - API keys already work through `ANTHROPIC_*` passthrough. Document them as first-class and soften the "no API key" pitch. Max, Ultra and Team plans include monthly API credits since 2026-10-07.
- **Market** (C18). Stores are failing on the update path: ShadyPanda's backdoor of about 300K badged users ([The Register](https://www.theregister.com/security/2025/12/01/browser-extensions-pushed-malware-to-43m-chrome-edge-users/2720642)), and GlassWorm's later-version `extensionPack` injection ([Socket](https://socket.dev/blog/open-vsx-transitive-glassworm-campaign)).
  - YAAR already avoids silent auto-update and already prompts when an update adds capabilities.
  - Remaining gaps: re-scan every version; show source diffs; prompt on updates that add no capability (and when `allowAllApps` is on); diff the **app agent prompt and the token's granted permissions**.
  - Don't headline iframe isolation as the security story. It does not cover those surfaces.
  - Use transparency signals (downloads, last change, open issues) the way the Home Assistant Marketplace does ([HA 2026.11](https://www.home-assistant.io/blog/2026/11/04/release-202611/)), not badges.
- **Cache TTL** (C11, [prompt caching](https://code.claude.com/docs/en/prompt-caching)). Each YAAR agent is a main-conversation SDK session and already gets a 1h TTL on a subscription within plan usage. For API-key or usage-credit users, set `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` in `buildClaudeEnv()`. The subagent variable does not reach these sessions. Measure real idle gaps first, because 1h writes cost 2x base input.
- **Don't** swap the warm pool for SDK `prewarm()`. Per-agent `X-Agent-Token` headers, MCP server sets filtered by `allowedTools`, per-agent prompts and frequent resumes make it a partial alpha option at best (C14).
- **Don't** expect MCP 2026-07-28 `ttlMs`/`cacheScope` to fix the reload cache. They are freshness hints on list and read results, and YAAR exposes its verbs as tools (C13).

### What we checked that did not hold

- **"YAAR's custom system prompt isn't cached" (C04, refuted).** A blog post found this for one-shot `claude -p --system-prompt` runs. YAAR's logs show the opposite on the SDK path. For example, `session_logs/2026-10-31_19-14-04` has 70 uncached input tokens against 4.84M cache reads.
- **"Artifacts are stateless captures, so YAAR owns persistent apps" (C12, refuted on the artifacts half).** Claude artifacts now have a per-artifact database, shared state and pages that save themselves. YAAR's remaining edge is narrower:
  - local ownership and open source;
  - a choice of provider;
  - many addressable windows forming one desktop;
  - typed app protocols driven by per-app agents;
  - in-place editing with rollback;
  - real network, filesystem and CDP reach.
- **Smaller corrections that changed the recommendations:**
  - AWO is EPFL's, not Microsoft's.
  - The SkillsBench "Haiku with skills beats Opus without" result was dropped in v4.
  - Provider memory is already disabled in YAAR.
  - PreToolUse hooks cannot return cached results.
  - Workflows are not model-free.
  - "Export reaches every host automatically" does not hold.
  - Google's generative UI in Search was announced at I/O and shipped later, on Gemini 3.5 Flash. The TechCrunch link cited for it covers Gemini Spark instead.
  - The ChatGPT sandbox subdomain naming is unconfirmed.
  - One verifier found no YAAR equivalent of MCP Apps' agent-only versus app-only tool visibility. Check `protocol.json` before assuming the mapping.

### Sources

- https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/
- https://github.com/modelcontextprotocol/ext-apps
- https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx
- https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- https://modelcontextprotocol.io/extensions/apps/overview
- https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt
- https://developers.openai.com/plugins/build/extensions
- https://devblogs.microsoft.com/microsoft365dev/mcp-apps-now-available-in-copilot-chat/
- https://forum.cursor.com/t/cursor-2-6-mcp-apps-and-team-marketplaces-for-plugins/153479
- https://cloud.google.com/blog/topics/developers-practitioners/devs-guide-to-mcp-apps-in-gemini
- https://www.sean-weldon.com/blog/2026-06-21-why-mcp-and-chatgpt-apps-use-double-iframes-fr%C3%A9d%C3%A9ric-barthelet-alpic
- https://code.claude.com/docs/en/agent-sdk/typescript.md
- https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
- https://learn.chatgpt.com/docs/app-server
- https://code.claude.com/docs/en/agent-sdk/overview.md
- https://arxiv.org/html/2602.18922v1
- https://arxiv.org/abs/2506.14852
- https://arxiv.org/html/2601.22037v2
- https://arxiv.org/pdf/2609.03236
- https://arxiv.org/abs/2510.04371
- https://code.claude.com/docs/en/workflows.md
- https://code.claude.com/docs/en/agent-sdk/subagents.md
- https://code.claude.com/docs/en/agent-sdk/structured-outputs.md
- https://heise.de/-10699104
- https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/
- https://techcrunch.com/2026/05/19/google-introduces-gemini-spark-a-24-7-agentic-assistant-with-gmail-integration/
- https://platform.claude.com/docs/en/about-claude/models/overview
- https://platform.claude.com/docs/en/about-claude/pricing
- https://www.technology.org/2026/10/08/claude-haiku-5-5-anthropic-price-benchmarks/
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/
- https://code.claude.com/docs/en/prompt-caching
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://code.claude.com/docs/en/mcp.md
- https://code.claude.com/docs/en/channels.md
- https://www.anthropic.com/engineering/code-execution-with-mcp
- https://code.claude.com/docs/en/hooks.md
- https://claude.com/blog/context-management
- https://arxiv.org/html/2505.16067v2
- https://arxiv.org/html/2602.12670v1
- https://arxiv.org/html/2510.04618v1
- https://arxiv.org/html/2509.25140v2
- https://arxiv.org/abs/2609.12742
- https://arxiv.org/abs/2509.12517
- https://arxiv.org/html/2503.03704v5
- https://code.claude.com/docs/en/memory
- https://learn.chatgpt.com/docs/customization/memories?surface=app
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- https://www.theregister.com/security/2025/12/01/browser-extensions-pushed-malware-to-43m-chrome-edge-users/2720642
- https://socket.dev/blog/open-vsx-transitive-glassworm-campaign
- https://obsidian.md/blog/future-of-plugins/
- https://obsidian.md/blog/2026-obsidian-october/
- https://www.home-assistant.io/blog/2026/11/04/release-202611/
- https://developers.raycast.com/information/security
- https://code.claude.com/docs/en/plugins/anthropic-marketplaces

## 3. Completeness critic (Opus)

**(1) Missing angles, competitors and evidence**
- **Rivals are absent.** The angle was searched, but the report never weighs YAAR against Cowork, Atlas, Comet, Copilot agent features, Lovable, v0, Opal or Replit. It gives no traction figures and does not say what made the successful ones take off. So the "jump over" half of the question is unanswered.
- **On-device and in-browser models are missing.** The report skips WebLLM, the Chrome Prompt API and Gemini Nano, even though YAAR already ships a WebGPU ONNX runtime. That is the obvious model-free router for Direction 2 and Direction 4, and it costs nothing per turn.
- **Cold start latency gets no answer.** It is a stated pain point, and the report only says what not to do.
- **Phone and remote use are not considered,** although YAAR's WebView and Android hosts are a real differentiator.
- **WebMCP is mentioned only in passing.** Its W3C standing and browser adoption are not covered.
- **There is no evidence of demand.** Nothing on YAAR's users, stars or retention, or on which features real sessions actually use.

**(2) Claims that look under-supported**
- **"MCP Apps is settled"** clashes with the draft framing rules changing three days ago (PR #717). The target is still moving.
- **"The per-app origin probably already satisfies the draft"** contradicts the report's own statement that bundled apps are same-origin and unsandboxed. Nobody has checked this against the code.
- **"gpt-6-luna," the two-tier Haiku 5.5 pricing, and "Max, Ultra and Team plans include API credits since 2026-10-07"** have no cited source, or none that clearly backs them.
- **The SMC latency figures are cited to arXiv 2510.04371,** while Speculative Macro Commit is cited elsewhere as 2609.03236. One of these citations is likely wrong.
- **Auth is rated "maintenance,"** yet the report itself mentions April enforcement against third-party harnesses. YAAR is one, so this is plausibly the biggest existential risk. The "fits the carve-out" claim rests on one docs page.
- **C04 is refuted with a single session** (`2026-10-31_19-14-04`).
- **Direction 2 is rated 0.6 confidence** with no measurement of how often flows repeat, even though the logs are local.

**(3) The first question for a follow-up round**
In YAAR's own `session_logs/`, what share of model turns are near-repeats of earlier typed `(appId, command, args-shape)` sequences, per app and per user? And what share of cost do those turns account for? This number sets the ceiling for Directions 2, 3 and 4. It decides whether crystallization or MCP Apps hosting should lead.
