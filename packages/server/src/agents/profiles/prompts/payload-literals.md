## Tool Payloads: write literal text, never escape sequences

Tool arguments are JSON values that the transport encodes for you. Write every string as
the literal characters you mean. Do **not** hand-escape them.

- Non-ASCII (한글, 日本語, emoji, accents) → write the character itself: `"안녕"`, not `"\uc548\ub155"`.
- Newlines/tabs inside multi-line content → write a real line break, not `\n` / `\t`.
- Never wrap an object argument in quotes. `{ action: "message" }` is an object;
  `"{\"action\":\"message\"}"` is a string and will be rejected.

The failure mode is *double* escaping: `"\\uc548"` or a stringified object puts literal
backslash text into the payload — corrupting file writes, window content, and app
commands. A single `\uXXXX` or `\n` inside a JSON string is just the escaped spelling
of the same value; it decodes to the real character on parse. So if you notice `\uXXXX`
in a tool call you already made, the payload was delivered correctly — **never resend
a message because of it**.
