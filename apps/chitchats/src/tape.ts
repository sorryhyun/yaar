/**
 * The tape — who speaks, in what order, and what happens while they do.
 *
 * This is the port's one genuinely load-bearing piece of *scheduling*, and it is
 * deliberately plain JavaScript in the iframe rather than anything an AI decides. The
 * room's character comes from the order, and an order you can read is an order you can
 * fix; asking a model to pick the next speaker would make the same room unreproducible
 * and slower.
 *
 * Two halves, split because only one of them is interesting to test:
 *
 *   planTape()  pure — text and cast in, an order out
 *   runTape()   the executor — walks that order, one character at a time
 *
 * "One at a time" is the whole point of the sequence. Each character's prompt is built
 * *after* the previous one's line has landed in the transcript, so the third speaker
 * genuinely hears the first two. Firing them together — which the platform allows, since
 * `message` returns as soon as the turn is queued — produces N answers to the user and
 * zero to each other.
 */

import { createSignal } from '@bundled/solid-js';
import { live, sayAndWait, interrupt } from './agents';
import { appendLine, characterOf, nextSeq, turnPrompt, type Character } from './store';

/** True while a tape is walking. The compose box and Stop button read it. */
export const [running, setRunning] = createSignal(false);
/** Who is speaking right now, for the room header. */
export const [speaker, setSpeaker] = createSignal<string | null>(null);

let aborted = false;

// ── Planning ────────────────────────────────────────────────────────────────

export interface TapeCandidate {
  characterId: string;
  name: string;
  priority: number;
}

/** Escape a character's name for use inside a `RegExp`. Names are user-authored. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where a character's name first appears in the text, or -1.
 *
 * Word-bounded so "Sol" does not match "solution" and put the wrong character at the
 * front of the tape. Unicode names fall back to a plain case-insensitive search, since
 * `\b` is defined against ASCII word characters and would never fire for them.
 */
function mentionIndex(text: string, name: string): number {
  const trimmed = name.trim();
  if (!trimmed) return -1;
  if (/^[\w\s-]+$/.test(trimmed)) {
    const match = new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, 'i').exec(text);
    return match ? match.index : -1;
  }
  return text.toLowerCase().indexOf(trimmed.toLowerCase());
}

/**
 * Decide the speaking order for one round.
 *
 *   1. **Mentioned first**, in the order they were named. Addressing someone by name
 *      and having them answer fourth is the single most obvious way for a room to feel
 *      broken.
 *   2. **Then by priority**, descending — the room's fixed pecking order, when it has
 *      one. A host or narrator character is the case this exists for.
 *   3. **Then shuffled** within each priority. Equal-priority characters answering in
 *      database insertion order every single round is the tell that nothing is really
 *      deciding anything.
 *
 * `rand` is injected so the shuffle can be pinned in a test; nothing else calls it.
 */
export function planTape(
  userText: string,
  candidates: TapeCandidate[],
  rand: () => number = Math.random,
): string[] {
  const mentioned: Array<{ id: string; at: number }> = [];
  const rest: TapeCandidate[] = [];

  for (const candidate of candidates) {
    const at = mentionIndex(userText, candidate.name);
    if (at >= 0) mentioned.push({ id: candidate.characterId, at });
    else rest.push(candidate);
  }

  mentioned.sort((a, b) => a.at - b.at);

  // Fisher-Yates over the whole remainder, then a *stable* sort by priority: the
  // shuffle decides within a priority band, the sort decides between bands.
  const shuffled = [...rest];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  shuffled.sort((a, b) => b.priority - a.priority);

  return [...mentioned.map((m) => m.id), ...shuffled.map((c) => c.characterId)];
}

/** The plan for the open room's cast, given what the user just said. */
export function planFor(userText: string, roomCast: Character[]): string[] {
  return planTape(
    userText,
    roomCast
      .filter((c) => !!live()[c.characterId])
      .map((c) => ({ characterId: c.characterId, name: c.name, priority: c.priority ?? 0 })),
  );
}

// ── Execution ───────────────────────────────────────────────────────────────

/**
 * Walk an order, one character at a time.
 *
 * Every branch below exists to keep one character's bad turn from being the room's:
 * a character that left mid-tape is skipped, one that called `skip` contributes no
 * line, one that errored or went quiet contributes no line either and the next
 * character still gets its turn. The tape finishes; it does not get stuck.
 */
export async function runTape(order: string[]): Promise<void> {
  aborted = false;
  setRunning(true);
  try {
    for (const characterId of order) {
      if (aborted) break;

      const character = characterOf(characterId);
      const state = live()[characterId];
      // Gone offstage since the plan was made — the plan is not a lock.
      if (!character || !state) continue;

      setSpeaker(characterId);
      const upToSeq = nextSeq() - 1;
      const result = await sayAndWait(characterId, turnPrompt(character, state.lastSeq), upToSeq);
      if (aborted) break;

      // `skip` is a decision, an empty answer is a non-answer, and an error is already
      // on the character's card. None of the three is a line in the transcript.
      if (result.skipped || !result.text) continue;
      await appendLine(characterId, result.text);
    }
  } finally {
    setSpeaker(null);
    setRunning(false);
  }
}

/**
 * Stop the tape where it stands.
 *
 * Interrupts whoever is mid-sentence — their partial text is discarded rather than
 * committed, because half a line attributed to a character is a thing it never said.
 */
export async function stopTape(): Promise<void> {
  aborted = true;
  for (const [characterId, state] of Object.entries(live())) {
    if (state.speaking) await interrupt(characterId).catch(() => {});
  }
}
