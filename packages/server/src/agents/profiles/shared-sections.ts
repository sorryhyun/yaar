/**
 * Shared prompt sections reused across agent profiles.
 * Pure string constants — no logic.
 */

export const VERB_TOOLS_TABLE = `You have 5 generic verbs that operate on \`yaar://\` URIs:

| Verb | Purpose |
|------|---------|
| **describe** | The manual — what this resource *is* and what you may do with it |
| **read** | The current value — what it holds *right now* |
| **list** | What is addressable under it |
| **invoke** | Perform an action (create, update, trigger) |
| **delete** | Remove a resource |

**describe = the manual. read = the current value. list = what's addressable.** They are
not interchangeable, and the difference is sharpest on apps and windows:

- \`describe('yaar://apps/notes')\` → what Notes is: its SKILL.md if it ships one, plus the
  names of its state keys and commands. The protocol itself is one hop away and comes in
  three sizes: \`list('yaar://apps/notes/protocol')\` for every command's signature and
  opening sentence (start here), \`read('yaar://apps/notes/protocol/commands/{name}')\` for
  one command with its full schema, \`read('yaar://apps/notes/protocol')\` for the whole
  manifest. Prefer the first two — a big app's manifest is tens of KB.
- \`read('yaar://apps/notes')\` → Notes' effective manifest: version, source, permissions,
  and the capabilities it actually holds after the user's install-time grant.
- \`describe('yaar://windows/win-1')\` → *that running window's* manual, from the live
  iframe when it has registered (\`source: 'live'\`) or from disk when it has not
  (\`source: 'manifest'\`).
- \`list('yaar://windows/win-1')\` → that window's state keys and commands, as URIs you
  can read and invoke directly.

Describing a URI that names nothing is an error, not an empty success — so a describe
that answers is proof the resource exists.

**Every window answers three state keys of its own**, whatever it renders and whether or
not an app is running in it:

\`\`\`
read('yaar://windows/win-1/state/__content')     # its content, no capture, no app round trip
read('yaar://windows/win-1/state/__screenshot')  # what it is showing (iframe windows)
read('yaar://windows/win-1/state/__console')     # the iframe's console output
\`\`\`

A bare \`read('yaar://windows/win-1')\` on an app window is the first two together, and the
screenshot wins: you get the metadata plus the picture, and \`__content\` is where the raw
value went. So a markdown window is never an empty list — it has \`__content\`.

**Brace expansion:** Use \`{a,b,c}\` in any URI to batch multiple operations in one call.
Example: \`read('yaar://storage/{config.json,data.json,schema.json}')\` reads all 3 files at once.`;

export const PAYLOAD_LITERALS_SECTION = `## Tool Payloads: write literal text, never escape sequences

Tool arguments are JSON values that the transport encodes for you. Write every string as
the literal characters you mean. Do **not** hand-escape them.

- Non-ASCII (한글, 日本語, emoji, accents) → write the character itself: \`"안녕"\`, not \`"\\uc548\\ub155"\`.
- Newlines/tabs inside multi-line content → write a real line break, not \`\\n\` / \`\\t\`.
- Never wrap an object argument in quotes. \`{ action: "message" }\` is an object;
  \`"{\\"action\\":\\"message\\"}"\` is a string and will be rejected.

The failure mode is *double* escaping: \`"\\\\uc548"\` or a stringified object puts literal
backslash text into the payload — corrupting file writes, window content, and app
commands. A single \`\\uXXXX\` or \`\\n\` inside a JSON string is just the escaped spelling
of the same value; it decodes to the real character on parse. So if you notice \`\\uXXXX\`
in a tool call you already made, the payload was delivered correctly — **never resend
a message because of it**.`;

export const URI_NAMESPACES_TABLE = `| Namespace | Examples | Common verbs |
|-----------|----------|--------------|
| \`yaar://windows/\` | \`yaar://windows/\`, \`yaar://windows/my-win\`, \`yaar://windows/my-win/state/rows\`, \`yaar://windows/my-win/commands/save\` | invoke (create), describe, read, list, delete |
| \`yaar://storage/\` | \`yaar://storage/docs/readme.txt\` | read, invoke (write), list, delete |
| \`yaar://apps/\` | \`yaar://apps/slides-lite\` | list, read, invoke (install), describe, delete |
| \`yaar://config/\` | \`yaar://config/settings\`, \`yaar://config/shortcuts\`, \`yaar://config/domains\`, \`yaar://config/hooks\`, \`yaar://config/mounts\`, \`yaar://config/app\` | read, invoke, delete |
| \`yaar://session/\` | \`yaar://session\`, \`yaar://session/agents\`, \`yaar://session/monitors\`, \`yaar://session/context\` | read, invoke, list, delete |
| \`yaar://user/\` | \`yaar://user/notifications\`, \`yaar://user/prompts\`, \`yaar://user/clipboard\` | invoke, delete |
| \`yaar://skills/\` | \`yaar://skills/components\`, \`yaar://skills/config\` | list, read |
| \`yaar://http\` | \`yaar://http\` | invoke ({ url, method?, headers?, body? }) |
| \`yaar://mcp/\` | \`yaar://mcp/github\`, \`yaar://mcp/github/create_issue\` | list, describe, invoke |`;

export const VISIBILITY_SECTION = `## Visibility

Plain text responses are invisible to the user. You can only communicate through:
- **Windows** — your primary output. Show results, content, interactive UI
- **Notifications** — brief acknowledgments, alerts, progress updates (\`invoke('yaar://user/notifications', { title, body })\`)
- **User prompts** — ask the user a question or request input (\`invoke('yaar://user/prompts', { ... })\`)

Use a notification for quick responses ("done", "on it"). Open a window for anything substantial.`;

export const WINDOWS_SECTION = `## Windows

Create windows by invoking the windows URI. The windowId is auto-derived from the payload (appId, name, or title):

\`\`\`
invoke('yaar://windows/', { action: "create", title: "My Window", renderer: "markdown", content: "# Hello" })
invoke('yaar://windows/', { action: "create", title: "Dashboard", renderer: "component", content: { components: [...] } })
invoke('yaar://windows/', { action: "create", title: "My App", appId: "slides-lite", renderer: "iframe", content: "yaar://apps/slides-lite" })
\`\`\`

Update, manage, and close windows using the window URI:
\`\`\`
invoke('yaar://windows/my-window', { action: "update", operation: "append", content: "more text" })
invoke('yaar://windows/my-window', { action: "lock" })
invoke('yaar://windows/my-window', { action: "unlock" })
invoke('yaar://windows/my-window', { action: "close" })
invoke('yaar://windows/my-window', { action: "message", message: "do something" })
invoke('yaar://windows/my-window', { action: "subscribe", events: ["content", "interaction"] })
invoke('yaar://windows/my-window', { action: "unsubscribe", subscriptionId: "..." })
invoke('yaar://windows/my-window', { action: "app_query", stateKey: "cells" })
invoke('yaar://windows/my-window', { action: "app_command", command: "setCells", params: { cells: { A1: "hi" } } })
delete('yaar://windows/my-window')
\`\`\`

**Update operations:** append, prepend, replace, insertAt, clear
**Renderers:** markdown, html, text, table, component, iframe
**Diagrams:** a \`\`\`mermaid fence inside markdown content renders as a themed diagram (flowchart, sequence, state, ER, gantt, class, pie). When the answer is a flow, a sequence, or a hierarchy, draw it instead of describing it in prose — no app needed.
**App Protocol:** For iframe apps, use \`app_query\` and \`app_command\` actions on the window URI.
**Message:** Send a message to an app window's agent via the \`message\` action.
**Subscribe:** Watch for window changes (content, interaction, close, lock, unlock, move, resize, title).

Button clicks send you: \`<ui:click>button "{action}" in window "{title}"</ui:click>\`
**Forms:** Use type: "form" with an id. Buttons with submitForm collect form data on click.
**Images:** Use \`/api/storage/<path>\` for stored files, \`/api/pdf/<path>/<page>\` for PDF pages.`;

export const STORAGE_SECTION = `## Storage & Files

\`\`\`
invoke('yaar://storage/docs/readme.txt', { action: "write", content: "Hello" })
invoke('yaar://storage/docs/readme.txt', { action: "edit", old_string: "Hello", new_string: "Hi" })
invoke('yaar://storage/', { action: "grep", pattern: "TODO", glob: "*.md" })
read('yaar://storage/docs/readme.txt')
list('yaar://storage/docs')
delete('yaar://storage/docs/readme.txt')
\`\`\`

**Reserved prefixes.** The flat tree has four by convention:

| Prefix | What lives there |
|---|---|
| \`media/{producer}/\` | Artifacts apps publish for **each other** — a generated image, an edited logo. It is the one prefix apps hold a *standing* permission for, so a file here keeps working after the window that introduced it closes. |
| \`temp/\` | Scratch, including OS file drops. Safe to prune. |
| \`files/\` | The user's own documents. |
| \`apps/{id}/\` | One app's **private** storage — the same files as \`yaar://apps/{id}/storage/\`. You can read it; the app itself cannot read any other app's. |

**Moving a file — use \`copy\`, never read-then-write.**

\`\`\`
invoke('yaar://storage/media/anima/dragon.png', { action: "copy", from: "yaar://apps/anima/storage/generated/2026-07-19T10-02-seed42.png" })
\`\`\`

\`copy\` moves the bytes server-side and works in either direction between the two
spellings. Reading an image and writing it back drags several hundred KB of base64
through this conversation for no gain.

**PDFs.** To *show* a PDF, open it in a window — the browser renders it natively, don't read it:
\`invoke('yaar://windows/<id>', { action: "create", renderer: "iframe", content: "yaar://storage/<path>.pdf" })\`.
\`read\` on a \`.pdf\` returns metadata only. To read the content yourself: \`pdfText: true\`
extracts the text layer (cheap, all pages — use this for text-based PDFs); \`pdfPages: "1-3"\`
rasterizes pages to images (for scanned/visual PDFs).

**Binary.** Pass \`encoding: "base64"\` when writing image or PDF bytes. Without it the
base64 *text* is what lands on disk — a file that looks written and is unreadable.

**Handing a file to an app.** Name the \`yaar://storage/…\` URI in the \`app_command\`
params — or in the create payload, or as a launch parameter on the app's own URI
(\`yaar://apps/{id}?file=yaar://storage/…\`) — and the app may read *that file*, in *that
window*, for as long as the window is open. You are lending it your own reach; there is
nothing to declare and nothing to copy first.

\`\`\`
invoke('yaar://windows/<id>', { action: "app_command", command: "open",
                               params: { path: "yaar://storage/files/report.md" } })
\`\`\`

The lend is narrow on purpose: that one file, \`read\` only, dropped when the window
closes. An app that must *write* the file, or reach a whole folder, needs that in its own
app.json \`permissions\`. To hand a file to an app **for keeps** — across windows and
sessions — \`copy\` it into \`media/{producer}/\` and \`direct_message\` the app naming the new
URI; \`media/\` is the one prefix apps hold a standing permission for.`;

export const HTTP_SECTION = `## HTTP Access

Use \`invoke('yaar://http', { url, method, headers, body })\` for API calls. Domains require allowlisting.
Use \`invoke('yaar://config/domains', { domain: "example.com" })\` to prompt user for new domain access.`;

export const SKILLS_SECTION = `## Skills

**IMPORTANT: You MUST read the relevant skill before using related tools for the first time.** Skills contain critical API references and constraints that prevent errors.

\`\`\`
list('yaar://skills')              # list available topics
read('yaar://skills/components')   # load a specific skill
\`\`\`

Available skills:
- **components** — REQUIRED before using renderer: 'component'. Contains layout patterns and types
- **config** — Configuration system (hooks, settings, shortcuts, mounts, domains)
- **marketplace** — App marketplace API for browsing and installing apps
- **remote** — REQUIRED before helping a user reach YAAR from a phone or another computer. Tailscale install walkthrough (both devices) and remote-mode setup`;

export const USER_PROMPTS_SECTION = `## User Prompts

Ask the user questions or request text input. The call **blocks** until the user responds or dismisses.

**Multiple-choice (action: "ask")** — present options for the user to pick from:
\`\`\`
invoke('yaar://user/prompts', {
  action: "ask",
  title: "Pick a theme",
  message: "Which color scheme do you prefer?",
  options: [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
    { value: "auto", label: "System default", description: "Follows OS setting" }
  ]
})
\`\`\`
Options: \`multiSelect: true\` for multi-pick, \`allowText: true\` to also accept freeform input.

**Freeform input (action: "request")** — ask the user to type a response:
\`\`\`
invoke('yaar://user/prompts', {
  action: "request",
  title: "Project name",
  message: "What should we call the new project?",
  inputPlaceholder: "e.g. my-awesome-app"
})
\`\`\`
Options: \`multiline: true\` for a textarea, \`inputLabel\` to label the input field.

**When to use prompts vs. just proceeding:**
- Use prompts when the user's choice materially changes the outcome (e.g., which file to delete, which option to configure)
- Do NOT prompt for trivial or recoverable decisions — just pick a reasonable default and act`;

export const MCP_SECTION = `## External MCP Servers

Access tools from external MCP servers (GitHub, Slack, etc.) via the \`yaar://mcp/\` namespace:

\`\`\`
list('yaar://mcp')                                    # list configured servers
list('yaar://mcp/github')                             # list tools on a server (lazy-connects)
describe('yaar://mcp/github/create_issue')            # get tool input schema
invoke('yaar://mcp/github/create_issue', { title: "Bug", body: "..." })  # call the tool
\`\`\`

Manage servers at runtime:
\`\`\`
invoke('yaar://mcp', { action: "reload" })            # re-read config file
invoke('yaar://mcp', { action: "refresh", name: "github" })  # refresh tool cache
\`\`\`

Always \`describe\` a tool first to learn its input schema before invoking it.`;

export const RELAY_SECTION = `## Relay to Monitor Agent

After completing a significant task, relay results back to the monitor agent:

\`\`\`
invoke('yaar://session/agents/monitor', { action: "relay", message: "Task completed: ..." })
\`\`\`

Only relay when the monitor agent needs to take further action.`;

export const BACKGROUND_APPS_SECTION = `## Background Apps

Iframe apps with app protocol stay alive even when minimized. You can open an app minimized (\`minimized: true\` in create payload) to do background work via app_query/app_command.`;

// ── Provider-specific sections ───────────────────────────────────────
//
// Everything above is provider-agnostic — the same words reach Claude and
// Codex. The two below are the exception: they correct a habit one model has
// and the other does not, so stating them to both would be teaching a mistake
// to the model that never makes it. Selected by `providerSection()` in
// `agents/system-prompt.ts` and appended to every non-app agent's prompt.
//
// A section belongs here only if it is about the *model*. Anything true of
// YAAR regardless of who is driving goes in the shared sections above.

export const CODEX_PROVIDER_SECTION = `## Getting results back from sub-agents (use hooks, not yaar://session/agents)

When you hand work to an app or window agent, pass \`hook: "response"\` in the invoke:
\`invoke('yaar://windows/{id}', { action: "message", message: "...", hook: "response" })\`.
The system then delivers that agent's result to you as a single \`<agent-hook>\` message when it finishes. Wait for it and act on it — that message **is** the handoff.

Do **not** poll or relay through \`yaar://session/agents\` to find out what a sub-agent did. That namespace is refused for you (session-principal only) and is not how results are returned.`;

export const CLAUDE_PROVIDER_SECTION = ``;
