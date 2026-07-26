/**
 * The store's shared ground: row shapes, collections, signals, and pure readers.
 *
 * This module imports nothing from its siblings, and that is the rule that keeps the
 * store acyclic. `characters.ts` needs `rooms.ts` (deleting a character uncasts it from
 * every room) and `transcript.ts` needs to name a speaker, so if the signals lived in
 * either of those the other would have to import it back. Everything shared sits here
 * instead, one level below all of them.
 */

import { createSignal } from '@bundled/solid-js';
import { appDb } from '@bundled/yaar';
import {
  EMPTY_PERSONA,
  buildSystemPrompt,
  parseConsolidatedMemory,
  type MemoryChunk,
  type Persona,
} from '../persona';

// ── Rows ────────────────────────────────────────────────────────

export interface RoomDoc {
  roomId: string;
  name: string;
  emoji: string;
  /** Who is cast in this room, in the order they were added. */
  characterIds: string[];
  createdAt: number;
  [key: string]: unknown;
}

export interface CharacterDoc {
  /** Stable across respawns — this is the personaId the platform keys on. */
  characterId: string;
  name: string;
  emoji: string;
  /**
   * Higher speaks earlier when nobody was mentioned by name. Ties are shuffled, so a
   * room of all-zeros is a room with no fixed pecking order — which is the default.
   */
  priority: number;
  /** Storage path of the avatar image, when one was uploaded. */
  avatarPath?: string;
  createdAt: number;
  [key: string]: unknown;
}

export interface MessageDoc {
  roomId: string;
  /** Monotonic within the room; what "everything since your last turn" is measured in. */
  seq: number;
  /** `user`, or a characterId. */
  speaker: string;
  text: string;
  ts: number;
  [key: string]: unknown;
}

export type Room = RoomDoc & { _id?: string };
export type Character = CharacterDoc & { _id?: string };
export type Message = MessageDoc & { _id?: string };

/** The collections. Internal to the store — not re-exported from the barrel. */
export const roomsC = appDb.collection<RoomDoc>('rooms');
export const charactersC = appDb.collection<CharacterDoc>('characters');
export const messagesC = appDb.collection<MessageDoc>('messages');

// ── Reactive state ───────────────────────────────────────────────

export const [rooms, setRooms] = createSignal<Room[]>([]);
export const [cast, setCast] = createSignal<Character[]>([]);
export const [openRoomId, setOpenRoomId] = createSignal<string | null>(null);
export const [transcript, setTranscript] = createSignal<Message[]>([]);

/**
 * Persona documents, keyed by characterId — the storage folders, cached.
 *
 * A signal rather than a plain map because the editor renders them: a save has to
 * repaint the textarea it came from, and a spawn has to read the *saved* text rather
 * than whatever the disk held when the window opened. It is also what `memorize` writes
 * through, so a character's own diary row is visible to the next spawn without a reload.
 */
export const [personas, setPersonas] = createSignal<Record<string, Persona>>({});
/** Avatar data URLs, keyed by characterId. Absent = render the emoji instead. */
export const [avatars, setAvatars] = createSignal<Record<string, string>>({});

// ── Readers ────────────────────────────────────────────────────

export function openRoom(): Room | undefined {
  const id = openRoomId();
  return id ? rooms().find((r) => r.roomId === id) : undefined;
}

export function characterOf(characterId: string): Character | undefined {
  return cast().find((c) => c.characterId === characterId);
}

/** The characters cast in the open room, in the room's own order. */
export function roomCast(): Character[] {
  const room = openRoom();
  if (!room) return [];
  return room.characterIds.map(characterOf).filter((c): c is Character => !!c);
}

/** Next sequence number in the open room. Derived rather than stored. */
export function nextSeq(): number {
  const all = transcript();
  return all.length === 0 ? 1 : all[all.length - 1].seq + 1;
}

export function personaOf(characterId: string): Persona {
  return personas()[characterId] ?? EMPTY_PERSONA;
}

/** This character's memory chunks, parsed from whatever is currently saved. */
export function memoryOf(characterId: string): MemoryChunk[] {
  return parseConsolidatedMemory(personaOf(characterId).consolidatedMemory);
}

/** The composed system prompt one character would be spawned with right now. */
export function systemPromptOf(character: Character): string {
  return buildSystemPrompt(character.name, personaOf(character.characterId));
}
