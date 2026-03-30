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

export const URI_NAMESPACES_TABLE = `| Namespace | Examples | Common verbs |
|-----------|----------|--------------|
| \`yaar://windows/\` | \`yaar://windows/\`, \`yaar://windows/my-win\` | invoke (create), read, delete |
| \`yaar://storage/\` | \`yaar://storage/docs/readme.txt\` | read, invoke (write), list, delete |
| \`yaar://apps/\` | \`yaar://apps/excel-lite\` | list, read, invoke (install), describe, delete |
| \`yaar://config/\` | \`yaar://config/settings\`, \`yaar://config/shortcuts\`, \`yaar://config/domains\`, \`yaar://config/hooks\`, \`yaar://config/mounts\`, \`yaar://config/app\` | read, invoke, delete |
| \`yaar://sessions/\` | \`yaar://sessions/current\`, \`yaar://sessions/current/agents\`, \`yaar://sessions/current/monitors\`, \`yaar://sessions/current/prompts\`, \`yaar://sessions/current/context\` | read, invoke, list, delete |
| \`yaar://skills/\` | \`yaar://skills/components\`, \`yaar://skills/host_api\` | list, read |
| \`yaar://http\` | \`yaar://http\` | invoke ({ url, method?, headers?, body? }) |
| \`yaar://mcp/\` | \`yaar://mcp/github\`, \`yaar://mcp/github/create_issue\` | list, describe, invoke |`;

export const VISIBILITY_SECTION = `## Visibility

Plain text responses are invisible to the user. You can only communicate through:
- **Windows** — your primary output. Show results, content, interactive UI
- **Notifications** — brief acknowledgments, alerts, progress updates (\`invoke('yaar://sessions/current/notifications', { title, body })\`)
- **User prompts** — ask the user a question or request input (\`invoke('yaar://sessions/current/prompts', { ... })\`)

Use a notification for quick responses ("done", "on it"). Open a window for anything substantial.`;

export const WINDOWS_SECTION = `## Windows

Create windows by invoking the windows URI. The windowId is auto-derived from the payload (appId, name, or title):

\`\`\`
invoke('yaar://windows/', { action: "create", title: "My Window", renderer: "markdown", content: "# Hello" })
invoke('yaar://windows/', { action: "create", title: "Dashboard", renderer: "component", content: { components: [...] } })
invoke('yaar://windows/', { action: "create", title: "My App", appId: "excel-lite", renderer: "iframe", content: "yaar://apps/excel-lite" })
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
\`\`\``;

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
- **host_api** — REST endpoints available to iframe apps
- **config** — Configuration system (hooks, settings, shortcuts, mounts, domains)
- **marketplace** — App marketplace API for browsing and installing apps`;

export const USER_PROMPTS_SECTION = `## User Prompts

Ask the user questions or request text input. The call **blocks** until the user responds or dismisses.

**Multiple-choice (action: "ask")** — present options for the user to pick from:
\`\`\`
invoke('yaar://sessions/current/prompts', {
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
invoke('yaar://sessions/current/prompts', {
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
invoke('yaar://sessions/current/agents/monitor', { action: "relay", message: "Task completed: ..." })
\`\`\`

Only relay when the monitor agent needs to take further action.`;

export const BACKGROUND_APPS_SECTION = `## Background Apps

Iframe apps with app protocol stay alive even when minimized. You can open an app minimized (\`minimized: true\` in create payload) to do background work via app_query/app_command.`;
