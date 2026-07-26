/**
 * The persona client — everything this app knows about `yaar://apps/self/agents`.
 *
 * Copied from Round Table (`apps/personas/src/agents.ts`) and then bent in one place,
 * which is the difference between the two apps:
 *
 *   Round Table  fires every character at once and never waits for any of them
 *   ChitChats    runs a *tape* — one character at a time, each hearing the last
 *
 * So this file owns something Round Table's does not: {@link sayAndWait}, a turn you
 * can await. `message` still returns the moment the turn is queued (that is the verb's
 * contract, and it is what makes concurrency possible at all); the promise resolves
 * later, off the stream's terminal frame. The tape executor is the only caller.
 *
 * The other difference is the tools. Characters are spawned with `skip`, `memorize`, and
 * — when they have a memory file — `recall`; calling any of them dispatches
 * `persona:{name}` to this very iframe, where `main.ts` registers the handlers. A
 * character that declines its turn therefore produces an *event*, not a string this file
 * has to recognize, and a character that remembers something writes a real file. What the
 * tool list *is* belongs to `persona.ts` (it is derived from the persona's documents); the
 * spawn call is all this file knows about it.
 */

import { createSignal } from '@bundled/solid-js';
import { invoke, list, del, stream, type StreamFrame } from '@bundled/yaar';
import * as z from '@bundled/zod';
import type { Character } from './store';
import type { CharacterTool } from './persona';
import {
  FrameDataSchema,
  PersonaHandleSchema,
  RosterSchema,
  parseOrThrow,
  type Roster,
} from './schema';

/** How long a turn may go without a single frame before the tape gives up on it. */
const TURN_IDLE_TIMEOUT_MS = 120_000;

/** What one character is doing right now. Absent from the map = not spawned. */
export interface Live {
  personaId: string;
  instanceId: string;
  streamUri: string;
  /** True from `message` until the turn's terminal frame. */
  speaking: boolean;
  /** Accumulated text deltas for the turn in flight. */
  draft: string;
  /** Accumulated thinking deltas — shown behind a fold. */
  thinking: string;
  /** Highest transcript seq this character has already been told about. */
  lastSeq: number;
  error?: string;
}

/** How a turn ended. The tape branches on this and on nothing else. */
export interface TurnResult {
  text: string;
  /** The character called `skip`. There is no line to append. */
  skipped: boolean;
  /** The turn failed or went silent; the tape moves on rather than stalling. */
  error?: string;
}

export const [live, setLive] = createSignal<Record<string, Live>>({});

/** Unsubscribe thunks, one per live persona. Not reactive — nothing renders them. */
const stops = new Map<string, () => void>();

/** Turns in flight, keyed by characterId. Resolved by the stream's terminal frame. */
const pending = new Map<
  string,
  { resolve: (result: TurnResult) => void; timer: ReturnType<typeof setTimeout> }
>();

/** Characters that called `skip` during the turn currently in flight. */
const skipped = new Set<string>();

function patch(personaId: string, changes: Partial<Live>): void {
  const current = live()[personaId];
  if (!current) return;
  setLive({ ...live(), [personaId]: { ...current, ...changes } });
}

/**
 * A character called its `skip` tool.
 *
 * Called from the `persona:skip` command handler, with the id the *server* stamped into
 * the payload — never one the model wrote. That stamp is why this can be a bare set:
 * a character cannot skip on another's behalf.
 */
export function noteSkip(personaId: string): void {
  skipped.add(personaId);
}

/** Settle a turn once, whatever ended it, and stop its watchdog. */
function settle(characterId: string, result: TurnResult): void {
  const turn = pending.get(characterId);
  if (!turn) return;
  pending.delete(characterId);
  clearTimeout(turn.timer);
  turn.resolve(result);
}

/** Restart the silence watchdog — any frame at all counts as progress. */
function keepAlive(characterId: string): void {
  const turn = pending.get(characterId);
  if (!turn) return;
  clearTimeout(turn.timer);
  turn.timer = setTimeout(() => {
    patch(characterId, { speaking: false });
    settle(characterId, {
      text: live()[characterId]?.draft?.trim() ?? '',
      skipped: false,
      error: 'went quiet',
    });
  }, TURN_IDLE_TIMEOUT_MS);
}

/**
 * Fold one stream frame into the character's row, and settle its turn when it ends.
 *
 * `text`/`thinking` carry *deltas*, so they append. `start` is the turn boundary —
 * without clearing there, a second turn's text would render as a continuation of the
 * first. `done` and `error` are terminals, and `done` carries the turn's final text,
 * which is preferred over the accumulated draft: it is the authoritative string, and a
 * dropped delta would otherwise leave a hole nobody notices.
 */
function onFrame(characterId: string, frame: StreamFrame): void {
  // A frame whose payload doesn't parse is dropped rather than thrown: this runs on a
  // live wire, and one odd frame must not take the room down with it.
  const parsed = z.safeParse(FrameDataSchema, frame.data ?? {});
  if (!parsed.success) {
    console.warn(`[chitchats] unreadable ${frame.kind} frame for ${characterId}`, frame.data);
    return;
  }
  const data = parsed.data;
  keepAlive(characterId);

  switch (frame.kind) {
    case 'start':
      patch(characterId, { speaking: true, draft: '', thinking: '', error: undefined });
      break;
    case 'text':
      patch(characterId, { draft: (live()[characterId]?.draft ?? '') + (data.content ?? '') });
      break;
    case 'thinking':
      patch(characterId, {
        thinking: (live()[characterId]?.thinking ?? '') + (data.content ?? ''),
      });
      break;
    case 'done': {
      const text = (data.text ?? live()[characterId]?.draft ?? '').trim();
      patch(characterId, { speaking: false, draft: '' });
      // A character that called `skip` may still have emitted a sentence around the
      // call. The tool is the decision; the prose is discarded.
      settle(characterId, { text, skipped: skipped.has(characterId) });
      break;
    }
    case 'error': {
      const message = data.error ?? 'stream error';
      patch(characterId, { speaking: false, error: message });
      settle(characterId, { text: '', skipped: false, error: message });
      break;
    }
  }
}

/**
 * Spawn a character's persona and start watching its stream.
 *
 * Idempotent on the server — spawning a personaId that already exists hands back the
 * live one with its memory intact — which is what makes an iframe reload cheap: call
 * this for every character in the room on mount and the room comes back as it was.
 *
 * That idempotence is also why an edited persona only takes effect on the *next* spawn:
 * the prompt and the tool list are fixed for a live sub-agent's lifetime, so a rewritten
 * memory file does not re-index the `recall` tool of a character already onstage.
 */
export async function spawn(
  character: Character,
  systemPrompt: string,
  tools: CharacterTool[],
): Promise<void> {
  const result = parseOrThrow(
    PersonaHandleSchema,
    await invoke('yaar://apps/self/agents', {
      action: 'spawn',
      personaId: character.characterId,
      systemPrompt,
      tools,
    }),
    'spawn',
  );

  setLive({
    ...live(),
    [character.characterId]: {
      personaId: result.personaId,
      instanceId: result.instanceId,
      streamUri: result.streamUri,
      speaking: false,
      draft: '',
      thinking: '',
      lastSeq: 0,
    },
  });

  stops.get(character.characterId)?.();
  const stop = await stream(result.streamUri, (frame) => onFrame(character.characterId, frame), {
    kinds: ['start', 'text', 'thinking', 'done', 'error'],
  });
  stops.set(character.characterId, stop);
}

/**
 * Give one character its turn and wait for the answer.
 *
 * The await is on the *stream*, not on the verb: `message` returns as soon as the turn
 * is queued. A turn that never produces a frame is settled by the watchdog rather than
 * left hanging, because a stalled character must cost the room one slow turn and not
 * the whole conversation.
 */
export async function sayAndWait(
  characterId: string,
  content: string,
  upToSeq: number,
): Promise<TurnResult> {
  if (!live()[characterId]) return { text: '', skipped: false, error: 'not onstage' };

  skipped.delete(characterId);
  patch(characterId, {
    speaking: true,
    draft: '',
    thinking: '',
    error: undefined,
    lastSeq: upToSeq,
  });

  const answer = new Promise<TurnResult>((resolve) => {
    pending.set(characterId, { resolve, timer: setTimeout(() => {}, 0) });
  });
  keepAlive(characterId);

  try {
    await invoke(`yaar://apps/self/agents/${characterId}`, { action: 'message', content });
  } catch (err) {
    // Includes the busy refusal (`busy: true` on the envelope). The tape schedules one
    // turn at a time, so busy here means the previous turn outlived its watchdog —
    // report it and let the tape carry on rather than retrying into the same wall.
    const message = err instanceof Error ? err.message : String(err);
    patch(characterId, { speaking: false, error: message });
    settle(characterId, { text: '', skipped: false, error: message });
  }

  return answer;
}

export async function interrupt(characterId: string): Promise<void> {
  await invoke(`yaar://apps/self/agents/${characterId}`, { action: 'interrupt' });
  patch(characterId, { speaking: false });
  settle(characterId, {
    text: live()[characterId]?.draft?.trim() ?? '',
    skipped: false,
    error: 'interrupted',
  });
}

export async function dispose(characterId: string): Promise<void> {
  stops.get(characterId)?.();
  stops.delete(characterId);
  settle(characterId, { text: '', skipped: false, error: 'left the room' });
  await del(`yaar://apps/self/agents/${characterId}`).catch(() => {});
  const next = { ...live() };
  delete next[characterId];
  setLive(next);
}

/** The platform's view of the roster — authoritative if this app's state drifted. */
export async function roster(): Promise<Roster> {
  return parseOrThrow(RosterSchema, await list('yaar://apps/self/agents'), 'roster');
}
