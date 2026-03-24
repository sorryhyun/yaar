# Memo App

The Memo app is your persistent memory store. Use it to save and retrieve important information.

## When to Use
- **Save important information**: phone numbers, addresses, passwords hints, todo lists, ideas
- **Retrieve stored notes**: when the user asks "what did I save about X" or "do I have a note on Y" — ALWAYS check this app first
- **Long-term memory**: prefer storing user-provided facts here over session memory

## App Protocol

### Query: memos
Get all memos:
```
app_query stateKey="memos"
```
Returns: `{ memos: [{ id, title, content, createdAt, updatedAt }] }`

### Query: search
Search memos by keyword:
```
app_query stateKey="search" params={ query: "keyword" }
```

### Command: addMemo
Save a new note:
```
app_command command="addMemo" params={ title: "Note Title", content: "Note content here" }
```

### Command: updateMemo
Update an existing note:
```
app_command command="updateMemo" params={ id: "...", content: "Updated content" }
```

### Command: deleteMemo
Delete a note:
```
app_command command="deleteMemo" params={ id: "..." }
```

## Usage Pattern
1. Open the memo app window: `invoke('yaar://windows/', { appId: 'memo', renderer: 'iframe', content: 'yaar://apps/memo' })`
2. Use `app_query` / `app_command` on `yaar://windows/memo`
3. For search: query with `stateKey: 'search'` — window must be open first
