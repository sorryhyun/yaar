# Memo — persistent notes

Long-term storage for notes, facts and plans. Treat it as the place the user's own
information lives between sessions: search before answering a "did I save…" question, and
write proactively after learning something durable.

## Without a window

The data is reachable through `appDb` directly, so no Memo window has to be open:

```js
invoke('yaar://apps/memo/db/memos', { action: 'search', query: '...' })
invoke('yaar://apps/memo/db/memos', { action: 'insert', doc: { title, content, createdAt, updatedAt } })
invoke('yaar://apps/memo/db/memos/{id}', { action: 'update', patch: { content, updatedAt } })
del('yaar://apps/memo/db/memos/{id}')
```

Timestamps are ISO strings, and an insert should carry **all four** fields — a doc missing
`createdAt`/`updatedAt` sorts unpredictably in the UI later.

## Migration

Notes written before the app moved to `appDb` are migrated when the Memo window opens. If
notes you expect are missing from a search, open the window once and search again before
concluding they were never saved.

## With a window open

State key `memos`; commands `searchMemos`, `addMemo`, `updateMemo`, `deleteMemo` on the
`memo` window. Use these when the user should *see* the change happen; use the `appDb`
calls above for background reads and writes.