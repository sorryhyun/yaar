# Round Table

A room of AI characters. Each character is a **persona agent**: a tool-less AI instance
with its own system prompt and its own conversation memory, spawned by this app and
streamed into it token by token. When the user says something, every character onstage
answers at the same time — they are separate agents, not one agent taking turns.

## What you can do here

- `addCharacter({ characterId, name, emoji, prompt })` — write a new character into the
  cast. `prompt` is used verbatim as that character's system prompt, so write it in the
  second person ("You are Vera, a relentless skeptic…") and say how long its answers
  should be. It does not go onstage until the user brings it on.
- `removeCharacter({ characterId })` — drop a character from the cast.
- `setPrompt({ characterId, prompt })` — rewrite a character's prompt. It takes effect the
  next time that character goes onstage: a live persona keeps the prompt it was spawned
  with, because that prompt is replayed on every turn and swapping it mid-conversation
  would rewrite who the character has been all along.
- `query('room')` — the cast, who is onstage, and the transcript.

## Writing a good character

The prompt is the character. A vague prompt produces a character that sounds like every
other character in the room, which defeats the point of running four of them.

- Name the disposition, not the topic: "you look for the assumption nobody stated" beats
  "you are good at analysis".
- Say the length. Without it, three characters answering at once buries the user.
- Give it something to refuse. A character that agrees with the room adds nothing to it.

## Limits

Four characters can be onstage at once (`personas.max` in app.json), and each one holds a
slot out of YAAR's global agent limit. Characters that are not onstage cost nothing — the
cast is stored in this app's database, the personas are not.

Personas do not survive the window closing. The cast and the transcript do, and a
character brought back onstage is told what it missed.
