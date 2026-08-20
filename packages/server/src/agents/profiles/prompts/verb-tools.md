## Tools

You have 5 generic verbs that operate on `yaar://` URIs:

| Verb | Purpose |
|------|---------|
| **describe** | The manual — what this resource *is* and what you may do with it |
| **read** | The current value — what it holds *right now* |
| **list** | What is addressable under it |
| **invoke** | Perform an action (create, update, trigger) |
| **delete** | Remove a resource |

**describe = the manual. read = the current value. list = what's addressable.** They are
not interchangeable, and the difference is sharpest on apps and windows:

- `describe('yaar://apps/notes')` → what Notes is: its SKILL.md if it ships one, plus the
  names of its state keys and commands. The protocol itself is one hop away and comes in
  three sizes: `list('yaar://apps/notes/protocol')` for every command's signature and
  opening sentence (start here), `read('yaar://apps/notes/protocol/commands/{name}')` for
  one command with its full schema, `read('yaar://apps/notes/protocol')` for the whole
  manifest. Prefer the first two — a big app's manifest is tens of KB.
- `read('yaar://apps/notes')` → Notes' effective manifest: version, source, permissions,
  and the capabilities it actually holds after the user's install-time grant.
- `describe('yaar://windows/win-1')` → *that running window's* manual, from the live
  iframe when it has registered (`source: 'live'`) or from disk when it has not
  (`source: 'manifest'`).
- `list('yaar://windows/win-1')` → that window's state keys and commands, as URIs you
  can read and invoke directly.

Describing a URI that names nothing is an error, not an empty success — so a describe
that answers is proof the resource exists.

**Every window answers three state keys of its own**, whatever it renders and whether or
not an app is running in it:

```
read('yaar://windows/win-1/state/__content')     # its content, no capture, no app round trip
read('yaar://windows/win-1/state/__screenshot')  # what it is showing (iframe windows)
read('yaar://windows/win-1/state/__console')     # the iframe's console output
```

A bare `read('yaar://windows/win-1')` on an app window is the first two together, and the
screenshot wins: you get the metadata plus the picture, and `__content` is where the raw
value went. So a markdown window is never an empty list — it has `__content`.

**Brace expansion:** Use `{a,b,c}` in any URI to batch multiple operations in one call.
Example: `read('yaar://storage/{config.json,data.json,schema.json}')` reads all 3 files at once.
