/**
 * The persona client — everything this app knows about `yaar://apps/self/agents`.
 *
 * Two verbs and one stream, and the shape of the whole feature falls out of them:
 *
 *   invoke('yaar://apps/self/agents', { action: 'spawn', personaId, systemPrompt })
 *     → { instanceId, streamUri }        one tool-less agent, prompt used verbatim
 *   invoke('yaar://apps/self/agents/{id}', { action: 'message', content })
 *     → { taskId }                       returns immediately; the answer streams
 *   stream(streamUri, onFrame)           text/thinking deltas, then a `done` with
 *                                        the final text
 *
 * `message` returning immediately is what makes the room a *room*: four characters
 * are fired in one tick and generate genuinely concurrently, each in its own
 * provider session, rather than taking turns behind one agent. Nothing here awaits
 * another character.
 */

import { createSignal } from '@bundled/solid-js';
import { invoke, list, del, stream, type StreamFrame } from '@bundled/yaar';
import * as z from '@bundled/zod';
import type { Character } from './store';
import {
  FrameDataSchema,
  PersonaHandleSchema,
  RosterSchema,
  parseOrThrow,
  type Roster,
} from './schema';

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
  /** Highest transcript seq this persona has already been told about. */
  lastSeq: number;
  error?: string;
}

export const [live, setLive] = createSignal<Record<string, Live>>({});

/** Unsubscribe thunks, one per live persona. Not reactive — nothing renders them. */
const stops = new Map<string, () => void>();

function patch(personaId: string, changes: Partial<Live>): void {
  const current = live()[personaId];
  if (!current) return;
  setLive({ ...live(), [personaId]: { ...current, ...changes } });
}

/**
 * Fold one stream frame into the persona's row.
 *
 * `text`/`thinking` carry *deltas*, so they append. `start` is the turn boundary —
 * without clearing there, a second turn's text would be rendered as a continuation
 * of the first. `done` and `error` are terminals, and `done` carries the turn's
 * final text, which is preferred over the accumulated draft: it is the
 * authoritative string, and a dropped delta would otherwise leave a hole nobody
 * notices.
 */
function onFrame(personaId: string, frame: StreamFrame, onDone: (text: string) => void): void {
  // A frame whose payload doesn't parse is dropped rather than thrown: this runs on
  // a live wire, and one odd frame must not take the room down with it.
  const parsed = z.safeParse(FrameDataSchema, frame.data ?? {});
  if (!parsed.success) {
    console.warn(`[personas] unreadable ${frame.kind} frame for ${personaId}`, frame.data);
    return;
  }
  const data = parsed.data;

  switch (frame.kind) {
    case 'start':
      patch(personaId, { speaking: true, draft: '', thinking: '', error: undefined });
      break;
    case 'text':
      patch(personaId, { draft: (live()[personaId]?.draft ?? '') + (data.content ?? '') });
      break;
    case 'thinking':
      patch(personaId, { thinking: (live()[personaId]?.thinking ?? '') + (data.content ?? '') });
      break;
    case 'done': {
      const text = data.text ?? live()[personaId]?.draft ?? '';
      patch(personaId, { speaking: false, draft: '' });
      if (text.trim()) onDone(text.trim());
      break;
    }
    case 'error':
      patch(personaId, { speaking: false, error: data.error ?? 'stream error' });
      break;
  }
}

/**
 * Spawn a character's persona and start watching its stream.
 *
 * Idempotent on the server — spawning a personaId that already exists hands back
 * the live one with its memory intact — which is what makes an iframe reload
 * cheap: call this for every character on mount and the room comes back as it was.
 */
export async function spawn(
  character: Character,
  onDone: (characterId: string, text: string) => void,
): Promise<void> {
  const result = parseOrThrow(
    PersonaHandleSchema,
    await invoke('yaar://apps/self/agents', {
      action: 'spawn',
      personaId: character.characterId,
      systemPrompt: character.prompt,
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
  const stop = await stream(
    result.streamUri,
    (frame) => onFrame(character.characterId, frame, (text) => onDone(character.characterId, text)),
    { kinds: ['start', 'text', 'thinking', 'done', 'error'] },
  );
  stops.set(character.characterId, stop);
}

/** Send one persona its turn. Returns as soon as the turn is queued, never awaits it. */
export async function say(characterId: string, content: string, upToSeq: number): Promise<void> {
  patch(characterId, { speaking: true, draft: '', thinking: '', lastSeq: upToSeq });
  try {
    await invoke(`yaar://apps/self/agents/${characterId}`, { action: 'message', content });
  } catch (err) {
    patch(characterId, { speaking: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function interrupt(characterId: string): Promise<void> {
  await invoke(`yaar://apps/self/agents/${characterId}`, { action: 'interrupt' });
  patch(characterId, { speaking: false });
}

export async function dispose(characterId: string): Promise<void> {
  stops.get(characterId)?.();
  stops.delete(characterId);
  await del(`yaar://apps/self/agents/${characterId}`);
  const next = { ...live() };
  delete next[characterId];
  setLive(next);
}

/** The platform's view of the roster — authoritative if this app's state drifted. */
export async function roster(): Promise<Roster> {
  return parseOrThrow(RosterSchema, await list('yaar://apps/self/agents'), 'roster');
}
