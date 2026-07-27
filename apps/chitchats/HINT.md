ChitChats (`chitchats`) runs rooms of AI characters. Each character is its own sub-agent
with its own prompt and its own memory, and a room answers **in turn** — whoever was
mentioned goes first, and each speaker hears what the ones before it just said. Open it
when the user wants a conversation *between* several viewpoints rather than one answer
listing them: a debate, an interview panel, a writers' room, a character to talk to over
time. Its `addCharacter` command casts someone on request ("make me a grumpy pirate") as
four third-person markdown documents — a nutshell, timeless traits, a chunked backstory the
character opens with a `recall` tool, and a diary it writes itself with `memorize`. Those
documents persist, so a character the user comes back to next week remembers the last
conversation. A character can also wear a profile picture instead of its emoji: `setAvatar`
takes any image already in storage, so "draw her and use it as her face" is a portrait from
Anima and one more call.
