# Memo App

The Memo app is your persistent memory store. Use it to save and retrieve important information.
Memos live in an app-scoped SQLite collection (`memos`) — you can query and write it directly,
no window needed.

## When to Use
- **Save important information**: phone numbers, addresses, passwords hints, todo lists, ideas
- **Retrieve stored notes**: when the user asks "what did I save about X" or "do I have a note on Y" — ALWAYS check this app first
- **Long-term memory**: prefer storing user-provided facts here over session memory

## Direct Database Access (preferred — works without a window)

Memo documents: `{ title: string, content: string, createdAt: string, updatedAt: string }`
(ISO timestamps). Always include all four fields when inserting. Open memo windows update live.

Caveat: notes saved before the appDb migration live in a legacy `memos.json` file until the
memo window is opened once (opening it migrates them). If a search finds nothing but the user
expects saved notes, open the memo window, then query again.

```
read('yaar://apps/memo/db/memos')                       → recent memos
invoke('yaar://apps/memo/db/memos', { action: 'search', query: 'keyword' })   → FTS, best first
invoke('yaar://apps/memo/db/memos', { action: 'find', filter: { title: 'Groceries' }, limit: 5 })
invoke('yaar://apps/memo/db/memos', { action: 'insert', doc: { title, content, createdAt, updatedAt } })
invoke('yaar://apps/memo/db/memos/{id}', { action: 'update', patch: { content, updatedAt } })
delete('yaar://apps/memo/db/memos/{id}')                → delete a memo
invoke('yaar://apps/memo/db/memos', { action: 'count' })
```

## Usage Pattern
- To read or search memos, go straight to the database — `invoke('yaar://apps/memo/db/memos', { action: 'search', query: '...' })`. No window required.
- Open a window only when the user wants to *see* the memos: `invoke('yaar://windows/', { appId: 'memo', renderer: 'iframe', content: 'yaar://apps/memo' })`
