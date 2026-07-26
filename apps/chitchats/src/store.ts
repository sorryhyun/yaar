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
 *   appStorage  the character's own documents — its prompt as markdown, its avatar
 *
 * The prompt lives in storage rather than in the row because that is what a character
 * *is*: an editable document the user (or the app agent) writes, one file per character,
 * exportable and diffable. The row holds what a list needs to render without opening
 * every document. Neither copy holds the other's field, so they cannot drift.
 */

import { createSignal } from '@bundled/solid-js';
import { appDb, appStorage } from '@bundled/yaar';

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
 * Prompt bodies, keyed by characterId — the storage documents, cached.
 *
 * A signal rather than a plain map because the editor renders them: a save has to
 * repaint the textarea it came from, and a spawn has to read the *saved* text rather
 * than whatever the disk held when the window opened.
 */
export const [prompts, setPrompts] = createSignal<Record<string, string>>({});
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

  // Prompts and avatars are per-character files; fetch them together rather than on
  // first render, so the cast list paints once instead of N times.
  await Promise.all(characterRows.map((c) => loadCharacterFiles(c)));
}

async function loadCharacterFiles(character: Character): Promise<void> {
  const prompt = await appStorage.read(promptPath(character.characterId)).catch(() => '');
  if (prompt) setPrompts({ ...prompts(), [character.characterId]: prompt });

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

function promptPath(characterId: string): string {
  return `characters/${characterId}/character.md`;
}

export interface CharacterInput {
  characterId: string;
  name: string;
  emoji: string;
  prompt: string;
  priority?: number;
}

export async function addCharacter(input: CharacterInput): Promise<Character> {
  const existing = characterOf(input.characterId);
  if (existing) {
    await writePrompt(input.characterId, input.prompt);
    return existing;
  }

  const doc: CharacterDoc = {
    characterId: input.characterId,
    name: input.name,
    emoji: input.emoji,
    priority: input.priority ?? 0,
    createdAt: Date.now(),
  };
  // The document first: a row pointing at a prompt that failed to write is a character
  // that spawns with nothing to be.
  await writePrompt(input.characterId, input.prompt);
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
  await appStorage.remove(promptPath(characterId)).catch(() => {});
  if (existing?.avatarPath) await appStorage.remove(existing.avatarPath).catch(() => {});
}

export function promptOf(characterId: string): string {
  return prompts()[characterId] ?? '';
}

export async function writePrompt(characterId: string, prompt: string): Promise<void> {
  await appStorage.save(promptPath(characterId), prompt);
  setPrompts({ ...prompts(), [characterId]: prompt });
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
