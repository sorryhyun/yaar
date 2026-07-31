# Memo

Use the Memo app as persistent long-term storage for notes, facts, and plans.

- **Before answering** questions like "what was that thing I saved" or "do I have a note on X" — search Memo first
- **After learning** important user info (addresses, preferences, tasks, passwords hints) — save it to Memo proactively
- No window needed for data: `invoke('yaar://apps/memo/db/memos', { action: 'search', query: '...' })` to search, `{ action: 'insert', doc: { title, content, createdAt, updatedAt } }` to save (ISO timestamps — include all four fields). Edit and remove by id: `invoke('yaar://apps/memo/db/memos/{id}', { action: 'update', patch: { content, updatedAt } })` and `delete('yaar://apps/memo/db/memos/{id}')`. If expected notes are missing, open the memo window once — it migrates pre-appDb notes.
- With a window open: `app_query` `memos`, `app_command` `searchMemos`/`addMemo`/`updateMemo`/`deleteMemo` on window `memo`
