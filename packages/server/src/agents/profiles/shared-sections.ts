/**
 * Shared prompt sections reused across agent profiles.
 * Pure string constants — no logic.
 */

export const VERB_TOOLS_TABLE = `You have 5 generic verbs that operate on \`yaar://\` URIs:

| Verb | Purpose |
|------|---------|
| **describe** | Discover what a URI supports — returns verbs, description, invoke schema |
| **read** | Get the current value/state of a resource |
| **list** | List child resources under a URI |
| **invoke** | Perform an action (create, update, trigger) |
| **delete** | Remove a resource |

Use \`describe(uri)\` to discover what actions a URI supports before invoking it.

**Brace expansion:** Use \`{a,b,c}\` in any URI to batch multiple operations in one call.
Example: \`read('yaar://storage/{config.json,data.json,schema.json}')\` reads all 3 files at once.`;

export const PAYLOAD_LITERALS_SECTION = `## Tool Payloads: write literal text, never escape sequences

Tool arguments are JSON values that the transport encodes for you. Write every string as
the literal characters you mean. Do **not** hand-escape them.

- Non-ASCII (한글, 日本語, emoji, accents) → write the character itself: \`"안녕"\`, not \`"\\uc548\\ub155"\`.
- Newlines/tabs inside multi-line content → write a real line break, not \`\\n\` / \`\\t\`.
- Never wrap an object argument in quotes. \`{ action: "message" }\` is an object;
  \`"{\\"action\\":\\"message\\"}"\` is a string and will be rejected.

A hand-written \`\\uXXXX\` gets escaped again on the wire, so the app, file, or window
receives the literal characters \`\\uc548\\ub155\` instead of the text — corrupting file
writes, window content, and app commands. Same for \`\\n\`, which lands as a backslash and
an "n" rather than a line break.`;

/**
 * One-line restatement of PAYLOAD_LITERALS_SECTION, appended to the tail of each
 * turn's prompt rather than the system prompt.
 *
 * The full section is already in every tier's system prompt, but on long turns —
 * exactly the ones that write the most payloads — it is thousands of tokens back
 * and agents were still emitting `\uXXXX`. This rides at the very end of the
 * prompt, after the user/relay content, so it is the most recent instruction in
 * context when the next tool call is composed. Appended to the prompt only, never
 * to the context tape, so stored history stays clean.
 */
export const PAYLOAD_LITERALS_REMINDER = `<reminder>In tool payloads write literal characters — 한글/日本語/emoji as themselves ("안녕", not "\\uc548\\ub155"), real line breaks not \\n, and object arguments as objects not quoted strings.</reminder>`;

export const URI_NAMESPACES_TABLE = `| Namespace | Examples | Common verbs |
|-----------|----------|--------------|
| \`yaar://windows/\` | \`yaar://windows/\`, \`yaar://windows/my-win\` | invoke (create), read, delete |
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
| \`media/{producer}/\` | Artifacts apps publish for **each other** — a generated image, an edited logo. Apps are granted \`yaar://storage/media/\` and nothing wider, so this is the one place a file can cross between them. |
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

**Binary.** Pass \`encoding: "base64"\` when writing image or PDF bytes. Without it the
base64 *text* is what lands on disk — a file that looks written and is unreadable.

This is how you hand an image from one app to another: \`copy\` it into
\`media/{producer}/\`, then \`direct_message\` the consuming app naming the new URI.
The app can read \`media/\` itself; it cannot read where the file came from.`;

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
- **marketplace** — App marketplace API for browsing and installing apps`;

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
