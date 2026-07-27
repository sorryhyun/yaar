/**
 * Characters — the row in `appDb`, and the folder of markdown documents in `appStorage`.
 *
 * The persona lives in storage rather than in the row because that is what a character
 * *is*: a folder of editable markdown documents the user (or the app agent, or the
 * character itself through `memorize`) writes. The row holds what a list needs to render
 * without opening every document. Neither copy holds the other's field, so they cannot
 * drift.
 */

import { appStorage } from '@bundled/yaar';
import { EMPTY_PERSONA, PERSONA_DOCS, personaDir, personaFrom, type Persona } from '../persona';
import { appendRecentEvent, recentEventRow } from '../persona';
import {
  cast,
  setCast,
  rooms,
  characterOf,
  personaOf,
  personas,
  setPersonas,
  avatars,
  setAvatars,
  charactersC,
  type Character,
  type CharacterDoc,
} from './state';
import { uncastFromRoom } from './rooms';

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

/**
 * Pull one character's persona and avatar off disk into the caches.
 *
 * Exported for `index.ts`'s `loadLibrary` only — not re-exported from the barrel.
 */
export async function loadCharacterFiles(character: Character): Promise<void> {
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
 * Store a character's picture and show it immediately.
 *
 * The bytes arrive already squared — `avatar.ts` owns the canvas pass, so this stays a
 * write. The extension rides in the path because that is what the storage layer reads
 * the mime type off on the way back out: a bare `avatar` file returns as text and would
 * render as a broken image.
 */
export async function saveAvatar(
  characterId: string,
  base64: string,
  mimeType: string,
): Promise<string> {
  const ext = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
  const path = `characters/${characterId}/avatar.${ext}`;
  const previous = characterOf(characterId)?.avatarPath;

  await appStorage.save(path, base64, { encoding: 'base64' });
  await updateCharacter(characterId, { avatarPath: path });
  setAvatars({ ...avatars(), [characterId]: `data:${mimeType};base64,${base64}` });

  // Last, and only once the new file is on disk: a picture uploaded as a .jpg over an
  // older .png would otherwise leave the previous file orphaned in storage forever.
  if (previous && previous !== path) await appStorage.remove(previous).catch(() => {});
  return path;
}

/**
 * Take a character's picture away, falling the whole UI back to its emoji.
 *
 * The row keeps an empty `avatarPath` rather than losing the key: `update` is a shallow
 * merge, so an `undefined` would be dropped from the patch and the old path would
 * survive in the stored document. Empty is falsy everywhere the path is read, which is
 * the same thing a character written before avatars existed looks like.
 */
export async function clearAvatar(characterId: string): Promise<void> {
  const existing = characterOf(characterId);
  if (!existing) throw new Error(`No character "${characterId}"`);
  if (existing.avatarPath) await appStorage.remove(existing.avatarPath).catch(() => {});
  await updateCharacter(characterId, { avatarPath: '' });

  const next = { ...avatars() };
  delete next[characterId];
  setAvatars(next);
}
