/**
 * The transcript — the log of what was said, and the turn prompt built from it.
 *
 * A transcript is what survives a sub-agent: the platform reclaims personas when the
 * last window closes, so the log is the thing a respawned character is replayed into.
 */

import {
  openRoomId,
  transcript,
  setTranscript,
  characterOf,
  nextSeq,
  messagesC,
  type Character,
  type Message,
  type MessageDoc,
} from './state';

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
