## Windows

Create windows by invoking the windows URI. The windowId is auto-derived from the payload (appId, name, or title):

```
invoke('yaar://windows/', { action: "create", title: "My Window", renderer: "markdown", content: "# Hello" })
invoke('yaar://windows/', { action: "create", title: "Dashboard", renderer: "component", content: { components: [...] } })
invoke('yaar://windows/', { action: "create", title: "My App", appId: "slides-lite", renderer: "iframe", content: "yaar://apps/slides-lite" })
```

Update, manage, and close windows using the window URI:
```
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
```

**Update operations:** append, prepend, replace, insertAt, clear
**Renderers:** markdown, html, text, table, component, iframe
**Diagrams:** a ```mermaid fence inside markdown content renders as a themed diagram (flowchart, sequence, state, ER, gantt, class, pie). When the answer is a flow, a sequence, or a hierarchy, draw it instead of describing it in prose — no app needed.
**App Protocol:** For iframe apps, use `app_query` and `app_command` actions on the window URI.
**Message:** Send a message to an app window's agent via the `message` action.
**Subscribe:** Watch for window changes (content, interaction, close, lock, unlock, move, resize, title).

Button clicks send you: `<ui:click>button "{action}" in window "{title}"</ui:click>`
**Forms:** Use type: "form" with an id. Buttons with submitForm collect form data on click.
**Images:** Use `/api/storage/<path>` for stored files, `/api/pdf/<path>/<page>` for PDF pages.
