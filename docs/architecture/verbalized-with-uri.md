# URI-Based Resource Addressing

Everything in YAAR — windows, files, apps, config, agents, notifications — is addressable as a `yaar://` URI, and exactly five generic verbs operate on all of them:

```
describe · read · list · invoke · delete
```

This document explains *why* the system is shaped this way. For the precise namespace tables, payload shapes, registry API, and token rules, see the [URI & Verb Reference](../reference/uri_reference.md).

## The Problem: Tools Don't Scale, Names Do

The conventional MCP design registers one tool per capability: `create_window`, `update_window`, `read_file`, `install_app`, … Every new app or feature adds tools, every tool adds schema to the system prompt, and the prompt grows linearly with the system's surface area. At 100 installed apps, the agent drowns in tool definitions before the conversation starts.

Filesystems solved this problem fifty years ago: don't give every file its own syscall — give every file a *name*, and keep the operation set tiny (`open`, `read`, `write`, `unlink`). YAAR applies the same move. Capabilities live in the *URI space*, which costs zero prompt tokens until an agent actually looks at one; the *operation set* is five verbs, fixed forever. An agent that encounters an unfamiliar resource calls `describe` on it and learns its schema at runtime — capability discovery happens during the conversation, not at prompt-assembly time. That is what keeps the system prompt under ~8K tokens regardless of how many apps are installed.

## What a URI Buys Beyond Token Economy

**One access-control chokepoint.** Because every operation names its target URI and verb, permission checking has a single natural home: `ResourceRegistry.execute()` resolves the caller's principal (`session` / `monitor` / `app`) and decides, before any handler runs. No route or tool invents its own permission logic. App sandboxing (`app.json` `permissions` lists URI prefixes), agent tiers (`yaar://session/*` is session-agent-only), and iframe token scoping are all expressed in the same vocabulary: *who may do which verb on which URI prefix*.

**Uniformity across callers.** Agents reach resources via MCP verb tools; iframe apps reach the same resources via `POST /api/verb` with a token; internal code calls the registry directly. Same URIs, same verbs, same checks — there is no second, weaker path to the same state.

**Things become referable.** A window can name another window (`subscribe` to `yaar://windows/{id}`), a shortcut can point at an app, a hook can target a config entry, and an agent can hand a URI to another agent — all without inventing per-feature reference types.

## Verb Semantics in One Breath

`describe` = introspection (what verbs, what schema). `read`/`list` = state and enumeration. `delete` = removal. Everything else — creation, mutation, side effects — is `invoke`: the URI says *what* is acted on, and the payload's `action` field (when a resource supports several) says *how*. Collapsing all writes into one verb is deliberate: the alternative is verb proliferation, which is the tool-explosion problem wearing a different hat.

```
read('yaar://storage/data.csv')
invoke('yaar://windows/', { action: 'create', title: 'Notes', renderer: 'markdown', content: '# Hi' })
invoke('yaar://session/agents/agent-1', { action: 'interrupt' })
describe('yaar://apps/slides-lite')
```

## The Session Root

`yaar://` is implicitly scoped to the current session — the scheme *is* the session root, the way `/` is a process's filesystem root. Session-wide resources (agents, monitors, logs, the real-browser door) live under `yaar://session/*`, the privileged namespace only the session agent may enter. User-facing interaction (notifications, prompts, clipboard) lives under the open `yaar://user/*` namespace, callable by every tier.

## See Also

- [URI & Verb Reference](../reference/uri_reference.md) — full namespace tables, payload shapes, `ResourceRegistry` API, iframe token lifecycle
- [OS Architecture Map](./os_architecture.md) — verbs as syscalls, URIs as the VFS namespace
- [FAQ](../faq.md) — the same story told conversationally
