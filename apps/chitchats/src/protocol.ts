/**
 * The App Protocol surface — what an agent can read and do.
 *
 * Descriptor maps live here rather than in `main.ts` so the entrypoint is the layout and
 * nothing else. Each map is a plain `const` object literal on purpose: the compiler reads
 * these statically to build the manifest, so a descriptor assembled by a function call, or
 * a description built from a template literal, would be a build error rather than a
 * quietly shrunken protocol. They are spread back together in `main.ts`.
 */

import * as z from '@bundled/zod';

import {
  rooms,
  openRoom,
  openRoomId,
  roomCast,
  transcript,
  characterOf,
  personaOf,
  memoryOf,
  systemPromptOf,
  loadRoom,
  createRoom,
  castInRoom,
  uncastFromRoom,
  addCharacter,
  removeCharacter,
  writePersona,
  noteRecentEvent,
  appendLine,
  nextSeq,
} from './store';
import { PERSONA_DOCS, findMemory, type Persona } from './persona';
import { live, dispose, noteSkip } from './agents';
import { running, speaker, planFor, runTape } from './tape';

export const appState = {
  room: {
    description:
      'The open room: its cast, who is onstage, and the transcript. Each cast entry ' +
      "carries the character's nutshell and its memory subtitles rather than its whole " +
      'persona — read one character in full with getPersona.',
    get: () => ({
      room: openRoom()
        ? { roomId: openRoom()!.roomId, name: openRoom()!.name, emoji: openRoom()!.emoji }
        : null,
      rooms: rooms().map((r) => ({ roomId: r.roomId, name: r.name })),
      cast: roomCast().map((c) => ({
        characterId: c.characterId,
        name: c.name,
        emoji: c.emoji,
        priority: c.priority,
        onstage: !!live()[c.characterId],
        inANutshell: personaOf(c.characterId).inANutshell,
        memories: memoryOf(c.characterId).map((chunk) => chunk.subtitle),
        recentEvents: personaOf(c.characterId).recentEvents,
      })),
      speaking: speaker(),
      transcript: transcript().map((m) => ({ speaker: m.speaker, text: m.text })),
    }),
  },
};

export const roomCommands = {
  createRoom: {
    description: 'Create a room and open it',
    params: z.object({ roomId: z.string(), name: z.string(), emoji: z.string() }),
    replay: 'never' as const,
    run: async (p) => {
      await createRoom(p);
      await loadRoom(p.roomId);
      return { roomId: p.roomId };
    },
  },
  addCharacter: {
    description:
      'Write a new character into the cast. A character is four markdown documents, all ' +
      'in the THIRD person — the app supplies the frame that turns them into "you are ' +
      'this person". `inANutshell` is who they are in one to three sentences. ' +
      '`characteristics` is "## Appearance" then "## Personality" as bullets, timeless ' +
      'traits only, and should say how long their answers run. `consolidatedMemory` is ' +
      'standalone "## [subtitle]" chunks, each ending with **Present thought:** "…" — ' +
      'these are NOT in the prompt; the character opens one with its recall tool, and the ' +
      'thought is the preview it decides on. Leave `recentEvents` alone: the character ' +
      'writes that itself. Pass roomId to cast it straight into a room.',
    params: z.object({
      characterId: z.string(),
      name: z.string(),
      emoji: z.string(),
      inANutshell: z.string(),
      characteristics: z.optional(z.string()),
      consolidatedMemory: z.optional(z.string()),
      recentEvents: z.optional(z.string()),
      priority: z.optional(z.number()),
      roomId: z.optional(z.string()),
    }),
    replay: 'never' as const,
    run: async (p) => {
      await addCharacter({
        characterId: p.characterId,
        name: p.name,
        emoji: p.emoji,
        priority: p.priority,
        persona: {
          inANutshell: p.inANutshell,
          characteristics: p.characteristics,
          consolidatedMemory: p.consolidatedMemory,
          recentEvents: p.recentEvents,
        },
      });
      const roomId = p.roomId ?? openRoomId();
      if (roomId) await castInRoom(roomId, p.characterId);
      return { characterId: p.characterId, castInto: roomId ?? null };
    },
  },
  setPersona: {
    description:
      "Rewrite some of a character's persona documents; the ones you omit are left alone. " +
      'Same four documents and same third-person rule as addCharacter. Takes effect the ' +
      'next time the character comes onstage — a live character keeps the persona it was ' +
      'spawned with, because that prompt and its recall index are replayed every turn and ' +
      'swapping them would rewrite who the character has been all along.',
    params: z.object({
      characterId: z.string(),
      inANutshell: z.optional(z.string()),
      characteristics: z.optional(z.string()),
      consolidatedMemory: z.optional(z.string()),
      recentEvents: z.optional(z.string()),
    }),
    run: async (p) => {
      const patch: Partial<Persona> = {};
      for (const doc of PERSONA_DOCS) {
        const body = p[doc.key];
        if (body !== undefined) patch[doc.key] = body;
      }
      if (Object.keys(patch).length === 0) {
        throw new Error('Give at least one document to write');
      }
      await writePersona(p.characterId, patch);
      return { updated: p.characterId, documents: Object.keys(patch) };
    },
  },
  getPersona: {
    description:
      "Read one character's four persona documents in full, plus its memory index and the " +
      'system prompt they compose into. Use this before rewriting a character, and to ' +
      'export one.',
    params: z.object({ characterId: z.string() }),
    replay: 'never' as const,
    run: async (p) => {
      const character = characterOf(p.characterId);
      if (!character) throw new Error(`No character "${p.characterId}"`);
      const persona = personaOf(p.characterId);
      return {
        characterId: character.characterId,
        name: character.name,
        emoji: character.emoji,
        priority: character.priority,
        ...persona,
        memories: memoryOf(p.characterId).map(({ subtitle, thought }) => ({
          subtitle,
          thought: thought ?? null,
        })),
        systemPrompt: systemPromptOf(character),
      };
    },
  },
  removeCharacter: {
    description: 'Delete a character, its persona documents, and its place in every room',
    params: z.object({ characterId: z.string() }),
    replay: 'never' as const,
    run: async (p) => {
      await dispose(p.characterId).catch(() => {});
      await removeCharacter(p.characterId);
      return { removed: p.characterId };
    },
  },
  castInRoom: {
    description: 'Put an existing character into a room (defaults to the open room)',
    params: z.object({ characterId: z.string(), roomId: z.optional(z.string()) }),
    replay: 'never' as const,
    run: async (p) => {
      const roomId = p.roomId ?? openRoomId();
      if (!roomId) throw new Error('No room is open and no roomId was given');
      await castInRoom(roomId, p.characterId);
      return { roomId, characterId: p.characterId };
    },
  },
  uncastFromRoom: {
    description: 'Take a character out of a room (defaults to the open room)',
    params: z.object({ characterId: z.string(), roomId: z.optional(z.string()) }),
    replay: 'never' as const,
    run: async (p) => {
      const roomId = p.roomId ?? openRoomId();
      if (!roomId) throw new Error('No room is open and no roomId was given');
      await uncastFromRoom(roomId, p.characterId);
      return { roomId, characterId: p.characterId };
    },
  },
  say: {
    description:
      'Say something to the open room as the user, and run one round of turns. Returns ' +
      'once every character has spoken or skipped.',
    params: z.object({ text: z.string() }),
    replay: 'never' as const,
    run: async (p) => {
      if (running()) throw new Error('The room is mid-round; wait for it to finish');
      await appendLine('user', p.text);
      await runTape(planFor(p.text, roomCast()));
      return {
        said: p.text,
        transcript: transcript()
          .filter((m) => m.seq >= nextSeq() - 8)
          .map((m) => ({ speaker: m.speaker, text: m.text })),
      };
    },
  },
};

// ── Character-facing ───────────────────────────────────────────────
// The handler halves of the tools each character is spawned with. Descriptions here
// are written for an *operator* reading the protocol; the character reads different
// ones, supplied at spawn (`persona.ts`). The `persona:` prefix is what keeps the two
// apart — it hides these entries from the app agent's manifest, so the concierge never
// reads a script meant for a character.
//
// `personaId` is stamped by the server rather than written by the model, which is what
// makes these safe as bare writes: a character cannot recall from, or scribble in,
// another character's documents.

export const personaCommands = {
  'persona:skip': {
    description:
      'Called by a character that declined its turn. Records the decision for the tape; ' +
      'no line is added to the transcript.',
    params: z.object({ personaId: z.string() }),
    replay: 'never' as const,
    run: async (p) => {
      noteSkip(p.personaId);
      return { skipped: p.personaId };
    },
  },
  'persona:recall': {
    description:
      'Called by a character opening one chunk of its own consolidated_memory.md by ' +
      'subtitle. Returns the chunk body with its present-day thought stripped — the ' +
      'thought was already the preview in the tool description, and handing it back would ' +
      'have the character read its own caption aloud.',
    params: z.object({ personaId: z.string(), subtitle: z.string() }),
    replay: 'never' as const,
    run: async (p) => {
      const chunks = memoryOf(p.personaId);
      const found = findMemory(chunks, p.subtitle);
      if (!found) {
        // Naming every subtitle rather than refusing: the tool's own index is elided
        // when a memory file is long, so a near-miss is a normal call, not an error.
        return {
          found: false,
          subtitle: p.subtitle,
          available: chunks.map((chunk) => chunk.subtitle),
        };
      }
      return { found: true, subtitle: found.subtitle, memory: found.content };
    },
  },
  'persona:memorize': {
    description:
      'Called by a character recording one line in its own recent_events.md. The row is ' +
      "date-stamped and appended; the tail of that file is in the character's system " +
      'prompt from its next spawn onward, which is how anything survives the window ' +
      'closing.',
    params: z.object({ personaId: z.string(), memory_entry: z.string() }),
    replay: 'never' as const,
    run: async (p) => {
      const entry = p.memory_entry.trim();
      if (!entry) throw new Error('A memory needs something in it');
      const row = await noteRecentEvent(p.personaId, entry);
      return { recorded: row };
    },
  },
};
