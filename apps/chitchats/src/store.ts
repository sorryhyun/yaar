/**
 * Rooms, cast, and transcript — the app's own memory.
 *
 * Sub-agents do not survive their window: the platform reclaims them when the last
 * window closes, because four idle agents holding four of ten global slots is a cost
 * the user did not ask for. Persistence is therefore *this* file's job, and the shape
 * below is chosen for that recovery — a character is a row you can respawn from, and a
 * transcript is a log you can replay into the respawned character's first message.
 * Nothing here needs a persona to be alive.
 *
 * Two stores, split by what the data *is* rather than by convenience:
 *
 *   appDb       rows the app queries — rooms, the cast, the transcript
 *   appStorage  the character's own documents — its persona as markdown, its avatar
 *
 * The persona lives in storage rather than in the row because that is what a character
 * *is*: a folder of editable markdown documents the user (or the app agent, or the
 * character itself through `memorize`) writes — see `persona.ts` for the format and why
 * it is four files. The row holds what a list needs to render without opening every
 * document. Neither copy holds the other's field, so they cannot drift.
 */

import { createSignal } from '@bundled/solid-js';
import { appDb, appStorage } from '@bundled/yaar';
import {
  EMPTY_PERSONA,
  PERSONA_DOCS,
  appendRecentEvent,
  buildSystemPrompt,
  parseConsolidatedMemory,
  personaDir,
  personaFrom,
  recentEventRow,
  type MemoryChunk,
  type Persona,
} from './persona';

// ── Rows ────────────────────────────────────────────────────────────────────

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

const roomsC = appDb.collection<RoomDoc>('rooms');
const charactersC = appDb.collection<CharacterDoc>('characters');
const messagesC = appDb.collection<MessageDoc>('messages');

// ── Reactive state ──────────────────────────────────────────────────────────

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

// ── Loading ─────────────────────────────────────────────────────────────────

export async function loadLibrary(): Promise<void> {
  const [roomRows, characterRows] = await Promise.all([
    roomsC.find({}, { sort: { createdAt: 1 } }),
    charactersC.find({}, { sort: { createdAt: 1 } }),
  ]);
  setRooms(roomRows);
  setCast(characterRows);

  // Personas and avatars are per-character files; fetch them together rather than on
  // first render, so the cast list paints once instead of N times.
  await Promise.all(characterRows.map((c) => loadCharacterFiles(c)));
}

async function loadCharacterFiles(character: Character): Promise<void> {
  const persona = await readPersona(character.characterId);
  setPersonas({ ...personas(), [character.characterId]: persona });

  if (!character.avatarPath) return;
  try {
    const { data, mimeType, encoding } = await appStorage.readBinary(character.avatarPath);
    if (encoding !== 'base64') return;
    setAvatars({ ...avatars(), [character.characterId]: `data:${mimeType};base64,${data}` });
  } catch {
    // An avatar that won't load is a missing picture, not a broken room.
  }
}

/** Load one room's transcript and make it the open room. */
export async function loadRoom(roomId: string): Promise<void> {
  // Capped: a long-running room's tail is what a newcomer needs, and the sub-agents
  // carry the rest in their own session memory anyway.
  const log = await messagesC.find({ roomId }, { sort: { seq: 1 }, limit: 300 });
  setOpenRoomId(roomId);
  setTranscript(log);
}

// ── Rooms ───────────────────────────────────────────────────────────────────

export async function createRoom(input: Pick<RoomDoc, 'roomId' | 'name' | 'emoji'>): Promise<Room> {
  const existing = rooms().find((r) => r.roomId === input.roomId);
  if (existing) return existing;

  const doc: RoomDoc = { ...input, characterIds: [], createdAt: Date.now() };
  const _id = await roomsC.insert(doc);
  const stored: Room = { ...doc, _id };
  setRooms([...rooms(), stored]);
  return stored;
}

export async function removeRoom(roomId: string): Promise<void> {
  const room = rooms().find((r) => r.roomId === roomId);
  if (room?._id) await roomsC.remove(room._id);
  await messagesC.removeWhere({ roomId });
  setRooms(rooms().filter((r) => r.roomId !== roomId));
  if (openRoomId() === roomId) {
    setOpenRoomId(null);
    setTranscript([]);
  }
}

async function updateRoom(roomId: string, patch: Partial<RoomDoc>): Promise<void> {
  const room = rooms().find((r) => r.roomId === roomId);
  if (!room?._id) return;
  await roomsC.update(room._id, patch);
  setRooms(rooms().map((r) => (r.roomId === roomId ? { ...r, ...patch } : r)));
}

export async function renameRoom(roomId: string, name: string): Promise<void> {
  await updateRoom(roomId, { name });
}

/** Put a character onstage in a room. Idempotent — casting twice is not two characters. */
export async function castInRoom(roomId: string, characterId: string): Promise<void> {
  const room = rooms().find((r) => r.roomId === roomId);
  if (!room || room.characterIds.includes(characterId)) return;
  await updateRoom(roomId, { characterIds: [...room.characterIds, characterId] });
}

export async function uncastFromRoom(roomId: string, characterId: string): Promise<void> {
  const room = rooms().find((r) => r.roomId === roomId);
  if (!room) return;
  await updateRoom(roomId, { characterIds: room.characterIds.filter((c) => c !== characterId) });
}

// ── Characters ──────────────────────────────────────────────────────────────

function docPath(characterId: string, file: string): string {
  return `${personaDir(characterId)}/${file}`;
}

/**
 * The single document every character used to be, before the format was four.
 *
 * Kept only as a migration source: a character written by an earlier version of this app
 * has one freeform second-person prompt and no folder structure. Its body becomes the
 * nutshell — the section that is injected verbatim — so the character keeps behaving
 * exactly as it did, and splitting it properly is something the user can do later, or
 * never.
 */
const LEGACY_PROMPT_FILE = 'character.md';

/** Read one character's persona folder, migrating a legacy single-document character. */
async function readPersona(characterId: string): Promise<Persona> {
  const read = (file: string) => appStorage.read(docPath(characterId, file)).catch(() => '');
  const bodies = await Promise.all(PERSONA_DOCS.map((doc) => read(doc.file)));

  const persona = { ...EMPTY_PERSONA };
  PERSONA_DOCS.forEach((doc, index) => {
    persona[doc.key] = bodies[index];
  });
  if (PERSONA_DOCS.some((doc) => persona[doc.key].trim())) return persona;

  const legacy = (await read(LEGACY_PROMPT_FILE)).trim();
  if (!legacy) return persona;

  persona.inANutshell = legacy;
  await appStorage.save(docPath(characterId, PERSONA_DOCS[0].file), legacy);
  // Only once the new document is on disk: a stale duplicate nothing reads is worse than
  // no duplicate, because the next person to edit it would watch nothing happen.
  await appStorage.remove(docPath(characterId, LEGACY_PROMPT_FILE)).catch(() => {});
  return persona;
}

export interface CharacterInput {
  characterId: string;
  name: string;
  emoji: string;
  persona: Partial<Persona>;
  priority?: number;
}

export async function addCharacter(input: CharacterInput): Promise<Character> {
  const existing = characterOf(input.characterId);
  if (existing) {
    await writePersona(input.characterId, input.persona);
    return existing;
  }

  const doc: CharacterDoc = {
    characterId: input.characterId,
    name: input.name,
    emoji: input.emoji,
    priority: input.priority ?? 0,
    createdAt: Date.now(),
  };
  // The documents first: a row pointing at a persona that failed to write is a character
  // that spawns with nothing to be.
  await writePersona(input.characterId, personaFrom(input.persona));
  const _id = await charactersC.insert(doc);
  const stored: Character = { ...doc, _id };
  setCast([...cast(), stored]);
  return stored;
}

export async function updateCharacter(
  characterId: string,
  patch: Partial<CharacterDoc>,
): Promise<void> {
  const existing = characterOf(characterId);
  if (!existing?._id) return;
  await charactersC.update(existing._id, patch);
  setCast(cast().map((c) => (c.characterId === characterId ? { ...c, ...patch } : c)));
}

export async function removeCharacter(characterId: string): Promise<void> {
  const existing = characterOf(characterId);
  if (existing?._id) await charactersC.remove(existing._id);
  setCast(cast().filter((c) => c.characterId !== characterId));

  // Out of the cast is out of every room; a room holding a dead id would schedule a
  // turn for nobody.
  for (const room of rooms()) {
    if (room.characterIds.includes(characterId)) await uncastFromRoom(room.roomId, characterId);
  }
  for (const doc of PERSONA_DOCS) {
    await appStorage.remove(docPath(characterId, doc.file)).catch(() => {});
  }
  if (existing?.avatarPath) await appStorage.remove(existing.avatarPath).catch(() => {});

  const next = { ...personas() };
  delete next[characterId];
  setPersonas(next);
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

/**
 * Save some of a character's documents.
 *
 * Only the keys present are written, so the editor saving one textarea does not rewrite
 * the diary the character is meanwhile appending to.
 */
export async function writePersona(characterId: string, patch: Partial<Persona>): Promise<void> {
  for (const doc of PERSONA_DOCS) {
    const body = patch[doc.key];
    if (body === undefined) continue;
    await appStorage.save(docPath(characterId, doc.file), body);
  }
  setPersonas({ ...personas(), [characterId]: { ...personaOf(characterId), ...patch } });
}

/**
 * Append one row to a character's diary, as its own `memorize` tool.
 *
 * Returns the row so the caller can hand it back to the character as the tool's result —
 * seeing what it just wrote is what keeps it from writing the same line twice.
 *
 * No locking, and none needed: the tape gives exactly one character the floor at a time,
 * so two `memorize` calls cannot interleave within a room.
 */
export async function noteRecentEvent(characterId: string, entry: string): Promise<string> {
  const when = new Date();
  const recentEvents = appendRecentEvent(personaOf(characterId).recentEvents, entry, when);
  await writePersona(characterId, { recentEvents });
  return recentEventRow(entry, when);
}

/**
 * Store an uploaded avatar and show it immediately.
 *
 * The extension rides in the path because that is what the storage layer reads the
 * mime type off on the way back out — a bare `avatar` file returns as text and would
 * render as a broken image.
 */
export async function saveAvatar(
  characterId: string,
  base64: string,
  mimeType: string,
): Promise<void> {
  const ext = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
  const path = `characters/${characterId}/avatar.${ext}`;
  await appStorage.save(path, base64, { encoding: 'base64' });
  await updateCharacter(characterId, { avatarPath: path });
  setAvatars({ ...avatars(), [characterId]: `data:${mimeType};base64,${base64}` });
}

// ── Transcript ──────────────────────────────────────────────────────────────

export async function appendLine(speaker: string, text: string): Promise<Message> {
  const roomId = openRoomId();
  if (!roomId) throw new Error('No room is open');

  const doc: MessageDoc = { roomId, seq: nextSeq(), speaker, text, ts: Date.now() };
  const _id = await messagesC.insert(doc);
  const stored: Message = { ...doc, _id };
  setTranscript([...transcript(), stored]);
  return stored;
}

export async function clearTranscript(): Promise<void> {
  const roomId = openRoomId();
  if (!roomId) return;
  await messagesC.removeWhere({ roomId });
  setTranscript([]);
}

/**
 * The turn's prompt for one character: everything said since it last spoke,
 * speaker-labeled, plus the instruction that keeps it in character.
 *
 * Only the *new* lines are sent. A sub-agent is a real provider session with its own
 * conversation memory, so replaying the whole transcript every turn would pay for the
 * same tokens twice and, worse, hand the character a second copy of things it already
 * said. `sinceSeq` of 0 — a respawn, or a character brought onstage mid-conversation —
 * sends the lot, which is the recovery path.
 *
 * This is also where a room stops being N monologues: it is called per speaker *during*
 * the tape, after the previous speaker's line has already landed in the transcript, so
 * each character genuinely hears the one before it.
 */
export function turnPrompt(character: Character, sinceSeq: number): string {
  const fresh = transcript().filter((m) => m.seq > sinceSeq && m.speaker !== character.characterId);

  const label = (speaker: string) =>
    speaker === 'user' ? 'User' : (characterOf(speaker)?.name ?? speaker);

  const heard =
    fresh.length === 0
      ? '(Nothing new has been said since your last turn.)'
      : fresh.map((m) => `${label(m.speaker)}: ${m.text}`).join('\n');

  return (
    `${heard}\n\n` +
    `Reply as ${character.name}, in one short paragraph. Do not narrate, do not prefix ` +
    `your name. If you have nothing worth adding, call the skip tool instead of saying so.`
  );
}
