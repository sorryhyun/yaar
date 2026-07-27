/**
 * Rooms, cast, and transcript — the app's own memory.
 *
 * Sub-agents do not survive their window: the platform reclaims them when the last
 * window closes, because four idle agents holding four of ten global slots is a cost
 * the user did not ask for. Persistence is therefore *this* package's job, and the shape
 * below is chosen for that recovery — a character is a row you can respawn from, and a
 * transcript is a log you can replay into the respawned character's first message.
 * Nothing here needs a persona to be alive.
 *
 * Two stores, split by what the data *is* rather than by convenience:
 *
 *   appDb       rows the app queries — rooms, the cast, the transcript
 *   appStorage  the character's own documents — its persona as markdown, its avatar
 *
 * Four modules under one barrel. `state.ts` holds the rows, signals and pure readers and
 * imports nothing from its siblings; `rooms.ts`, `characters.ts` and `transcript.ts`
 * each own their mutations and all sit above it. That direction is what keeps the store
 * acyclic now that `removeCharacter` has to reach into `rooms.ts`.
 */

import { roomsC, charactersC, setRooms, setCast } from './state';
import { loadCharacterFiles } from './characters';

/**
 * Load every room and character, then every character's files.
 *
 * Lives in the barrel because it is the one operation that spans all three domains —
 * putting it in any single module would have that module import its siblings.
 */
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

export {
  rooms,
  setRooms,
  cast,
  setCast,
  openRoomId,
  setOpenRoomId,
  transcript,
  setTranscript,
  personas,
  setPersonas,
  avatars,
  setAvatars,
  openRoom,
  characterOf,
  roomCast,
  nextSeq,
  personaOf,
  memoryOf,
  systemPromptOf,
  type Room,
  type Character,
  type Message,
  type RoomDoc,
  type CharacterDoc,
  type MessageDoc,
} from './state';

export { loadRoom, createRoom, removeRoom, renameRoom, castInRoom, uncastFromRoom } from './rooms';

export {
  addCharacter,
  updateCharacter,
  removeCharacter,
  writePersona,
  noteRecentEvent,
  saveAvatar,
  clearAvatar,
  type CharacterInput,
} from './characters';

export { appendLine, clearTranscript, turnPrompt } from './transcript';
