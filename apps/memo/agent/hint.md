# Memo

Use Memo as persistent long-term storage for notes, facts and plans. Search it **before** answering "what was that thing I saved" or "do I have a note on X", and save important user info (addresses, preferences, tasks) there proactively after learning it.

Gotcha: no window is needed for data — `invoke('yaar://apps/memo/db/memos', { action: 'search', query })` reads and `{ action: 'insert', doc: { title, content, createdAt, updatedAt } }` writes (ISO timestamps, all four fields). If expected notes are missing, open the memo window once; it migrates pre-appDb notes.