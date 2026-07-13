# AI Chat

A chat UI. The user types a message; you answer it by writing a bubble into the app.

## Launch

Open this app in an iframe window:

```
invoke('yaar://windows/ai-chat', {
  action: "create",
  title: "AI Chat",
  renderer: "iframe",
  content: "yaar://apps/ai-chat"
})
```

Only ever create ONE window for this app. If a window with id `ai-chat` already
exists, focus it — do not create a second one.

## Answering a message

Each user message arrives as a `user_message` interaction carrying a `msgId`.
That `msgId` is the turn id.

**Call `addMessage` exactly once, with `replyTo` set to that `msgId`.**

```
app_command addMessage { content: "<your full reply>", replyTo: "<msgId>" }
```

That single call completes the turn. Then stop.

- Your plain-text response is **not** shown to the user — only `addMessage`
  renders a bubble. Do not also write a chat reply in prose.
- Do **not** send a follow-up confirmation, acknowledgement, or "done" message.
- `addMessage` returns `{ added: true }` when your reply was displayed.
- It returns `{ added: false, reason: "already-answered" }` when the turn already
  has a reply. **This is not a failure and it is not a prompt to retry.** The
  reply is on screen; calling again will not add it. Stop.
- Use `setError` (same one-call, same `replyTo`) if you must report a failure.

## Checking your work

`app_query messages` returns what is currently displayed. Use it to confirm a
reply landed — but note that a message being present in `messages` already means
it is rendered. Do not re-send on the assumption that it is invisible.
