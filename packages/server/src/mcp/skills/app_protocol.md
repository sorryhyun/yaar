# App Protocol

To make a deployed app controllable by the agent — so it can read app state and send commands — define an App Protocol. Without it, the app is a static iframe the agent cannot interact with after creation.

`window.yaar.app` is auto-injected at runtime (no import needed). The agent discovers your app's manifest, then queries state or sends commands at any time.

## Registration

Call `register()` **at the end of main.ts** after all DOM setup is complete. Always guard with a null check:

```ts
const appApi = (window as any).yaar?.app;
if (appApi) {
  appApi.register({
    appId: 'my-app',
    name: 'My App',
    state: { /* ... */ },
    commands: { /* ... */ },
  });
}
```

## State

State keys expose read-only snapshots. Handlers are called on-demand when the agent queries.

```ts
state: {
  items: {
    description: 'All items as an array',
    handler: () => [...items],  // return a copy, not the original
  },
  selection: {
    description: 'Currently selected item id or null',
    handler: () => selectedId,
  },
}
```

- Handlers can be sync or async (promises are auto-awaited)
- Return JSON-serializable values only (no Date, Map, Set, circular refs)
- Return copies of objects/arrays (`{...obj}`, `[...arr]`) to prevent mutation

## Commands

Commands are actions the agent can trigger. Use JSON Schema for `params`:

```ts
commands: {
  addItem: {
    description: 'Add a new item',
    params: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        priority: { type: 'number' },
      },
      required: ['title'],
    },
    handler: (p: { title: string; priority?: number }) => {
      items.push({ id: nextId++, title: p.title, priority: p.priority ?? 0 });
      render();
      return { ok: true, id: nextId - 1 };
    },
  },
  clear: {
    description: 'Remove all items',
    params: { type: 'object', properties: {} },
    handler: () => {
      items.length = 0;
      render();
      return { ok: true };
    },
  },
}
```

- Handlers can be sync or async
- Return `{ ok: true, ...extraData }` on success
- Throw on error — the SDK catches and reports it to the agent
- `params` uses JSON Schema format: `{ type: 'object', properties: { ... }, required: [...] }`

## Sending Interactions

Call `sendInteraction()` to proactively notify the agent about user actions:

```ts
window.yaar.app.sendInteraction('User clicked save button');
window.yaar.app.sendInteraction({ event: 'cell_select', row: 3, col: 'A' });
```

The interaction is delivered to the window's agent as a `WINDOW_MESSAGE`. Use for significant events the agent should know about — user selections, button clicks, mode changes, etc.
