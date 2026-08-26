---
name: storage-overrides
description: Read before giving an app a save/load/export command, or when its files are renderings (.docx, .xlsx, .md) of some in-memory state — how to override the built-in storage:* verbs instead of shipping a second write command.
audience: agent
---

## Storage Overrides

Every app agent holds four built-ins — `storage:read`, `storage:write`, `storage:delete`,
`storage:list` — that move raw bytes in two trees: the app's own (a relative path) and the
commons (`shared/{path}`, the same as `yaar://storage/shared/{path}`, where apps publish
files for each other). Neither needs a permission. Anything further under `yaar://storage/`
costs an `app.json` entry and always runs the built-in.

Raw bytes are right for an app that *keeps files* and wrong for an app whose files are
**renderings** of something else: a document editor's `report.docx`, `report.md` and
`report.json` are one document in three formats. If such an app ships its own
`saveDocument` beside the built-in `storage:write`, its agent now holds two write calls with
the same verb and different semantics, and the one that writes `content` verbatim under a
`.docx` name produces a file nothing can open. That failure has been reported more than once.

### The pattern: take the built-in's name

Declare a command **named** `storage:write` (and `storage:read` / `storage:delete` when the
same reasoning applies). The runtime hands the agent's call to your handler instead of the
built-in — same name the agent was taught, your semantics, and `describe` shows your
description. The handler receives `{ path, ...params }`; `path` is the relative path the
agent typed, or the commons URI (`yaar://storage/shared/…`) when it named the commons.

```ts
'storage:write': defineAppCommand({
  description:
    "Save the document — overrides the built-in storage:write, so it takes no `content`. " +
    "Params: { path: string }. The extension picks the format: .json (lossless), .md, .docx.",
  params: z.object({ path: z.string() }),
  replay: 'never', // a remount must not overwrite the file with whatever is loaded then
  run: async (p) => {
    const bytes = serialize(document(), extOf(p.path));
    await writeTo(p.path, bytes); // appStorage for a relative path, invoke(uri) for the commons
    return { path: p.path, bytes: bytes.length };
  },
}),
'storage:read': defineAppCommand({
  description: 'Read one file as text without touching the document. Params: { path: string }.',
  params: z.object({ path: z.string() }),
  run: (p) => readFrom(p.path),
}),
```

Rules that keep it honest:

- **One name per verb.** Never add an alias (`saveToStorage`) or a sibling
  (`deleteFromStorage`) "for the URI case" — every path your handler can reach is already
  routed to it, and a second name is a second door with the same semantics. The gated part
  of the shared tree is the platform's, not yours, and never arrives.
- **Say in the description that it is an override and what it takes.** The agent reads
  `describe` before calling; "takes the document, not `content`" is the sentence that stops
  it from stuffing a string into `params`.
- **Answer in a structured shape** (`{ path, bytes }`, `{ path, deleted }`) so the caller
  parses one reply whichever tree answered.
- **Load is a different command.** `storage:read` returns a file; a command that *replaces
  the document* from a file is `loadFromStorage` or similar — reading must not mutate.
- **Override only what you change.** An app that stores plain files needs none of this;
  leave the built-ins alone and let `appStorage` be the door.

`storage:list` is rarely worth overriding — a listing is a listing. Reference implementation:
the `word-excel` app's `src/protocol/files.ts`; runtime rule:
`packages/server/src/mcp/app-agent/storage-override.ts`.
