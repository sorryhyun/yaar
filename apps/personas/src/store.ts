/**
 * Cast and transcript — the app's own memory.
 *
 * Personas do not survive their window: the platform reclaims them when the last
 * window closes, because four idle agents holding four of ten global slots is a
 * cost the user did not ask for. Persistence is therefore *this* file's job, and
 * the shape below is chosen for that recovery: a character is a row you can respawn
 * from, and the transcript is a log you can replay into the respawned persona's
 * first message. Nothing here needs the personas to be alive.
 */

import { createSignal } from '@bundled/solid-js';
import { appDb } from '@bundled/yaar';

/** A character as stored. `_id` is the server's, added on read. */
export interface CharacterDoc {
  /** Stable across respawns — this is the personaId the platform keys on. */
  characterId: string;
  name: string;
  emoji: string;
  /** Verbatim system prompt. This *is* the character. */
  prompt: string;
  createdAt: number;
  [key: string]: unknown;
}

export interface LineDoc {
  /** Monotonic within the room; what "everything since your last turn" is measured in. */
  seq: number;
  /** `user`, or a characterId. */
  speaker: string;
  text: string;
  ts: number;
  [key: string]: unknown;
}

export type Character = CharacterDoc & { _id?: string };
export type Line = LineDoc & { _id?: string };

const characters = appDb.collection<CharacterDoc>('characters');
const lines = appDb.collection<LineDoc>('lines');

export const [cast, setCast] = createSignal<Character[]>([]);
export const [transcript, setTranscript] = createSignal<Line[]>([]);

/** Next sequence number. Derived rather than stored — one less thing to keep true. */
export function nextSeq(): number {
  const all = transcript();
  return all.length === 0 ? 1 : all[all.length - 1].seq + 1;
}

export async function loadRoom(): Promise<void> {
  const [people, log] = await Promise.all([
    characters.find({}, { sort: { createdAt: 1 } }),
    lines.find({}, { sort: { seq: 1 }, limit: 200 }),
  ]);
  setCast(people);
  setTranscript(log);
}

export type CharacterInput = Pick<CharacterDoc, 'characterId' | 'name' | 'emoji' | 'prompt'>;

export async function addCharacter(input: CharacterInput): Promise<void> {
  const doc: CharacterDoc = { ...input, createdAt: Date.now() };
  const _id = await characters.insert(doc);
  setCast([...cast(), { ...doc, _id }]);
}

export async function updateCharacter(
  characterId: string,
  patch: Partial<CharacterDoc>,
): Promise<void> {
  const existing = cast().find((c) => c.characterId === characterId);
  if (!existing?._id) return;
  await characters.update(existing._id, patch);
  setCast(cast().map((c) => (c.characterId === characterId ? { ...c, ...patch } : c)));
}

export async function removeCharacter(characterId: string): Promise<void> {
  const existing = cast().find((c) => c.characterId === characterId);
  if (existing?._id) await characters.remove(existing._id);
  setCast(cast().filter((c) => c.characterId !== characterId));
}

export async function appendLine(speaker: string, text: string): Promise<Line> {
  const line: LineDoc = { seq: nextSeq(), speaker, text, ts: Date.now() };
  const _id = await lines.insert(line);
  const stored: Line = { ...line, _id };
  setTranscript([...transcript(), stored]);
  return stored;
}

export async function clearTranscript(): Promise<void> {
  await lines.removeWhere({ seq: { $gte: 0 } });
  setTranscript([]);
}

/**
 * The turn's prompt for one character: everything said since it last spoke,
 * speaker-labeled, plus a nudge to stay in character.
 *
 * Only the *new* lines are sent. A persona is a real provider session with its own
 * conversation memory, so replaying the whole transcript every turn would pay for
 * the same tokens twice and, worse, present the character with a second copy of
 * things it already said. `sinceSeq` of 0 (a respawn) sends the lot, which is the
 * recovery path.
 */
export function turnPrompt(character: Character, sinceSeq: number): string {
  const fresh = transcript().filter((l) => l.seq > sinceSeq && l.speaker !== character.characterId);
  if (fresh.length === 0) return '(Nothing new was said. Say something anyway, briefly.)';

  const label = (speaker: string) =>
    speaker === 'user' ? 'User' : (cast().find((c) => c.characterId === speaker)?.name ?? speaker);

  return (
    fresh.map((l) => `${label(l.speaker)}: ${l.text}`).join('\n') +
    `\n\nReply as ${character.name}, in one short paragraph. Do not narrate, do not prefix your name.`
  );
}
