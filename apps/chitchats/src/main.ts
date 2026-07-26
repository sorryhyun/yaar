import { createSignal, createMemo, For, Show, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { defineApp, showToast, showConfirm, errMsg } from '@bundled/yaar';
import * as z from '@bundled/zod';

import {
  rooms,
  cast,
  transcript,
  openRoomId,
  openRoom,
  roomCast,
  characterOf,
  promptOf,
  avatars,
  loadLibrary,
  loadRoom,
  createRoom,
  removeRoom,
  renameRoom,
  castInRoom,
  uncastFromRoom,
  addCharacter,
  updateCharacter,
  removeCharacter,
  writePrompt,
  saveAvatar,
  appendLine,
  clearTranscript,
  nextSeq,
  type Character,
  type Message,
  type Room,
} from './store';
import { live, spawn, dispose, roster, noteSkip } from './agents';
import { running, speaker, planFor, runTape, stopTape } from './tape';
import './styles.css';

/**
 * The room a first-run user lands in.
 *
 * Three characters rather than four: the fourth slot is the one a user spends on a
 * character of their own, and a room that is already at capacity teaches the wrong
 * first lesson. It is also the honest default while every sub-agent costs a slot out of
 * the global `MAX_AGENTS` pool — a full room plus the standing session/monitor/app trio
 * is 7 of the default 10.
 */
const STARTER_ROOM = { roomId: 'green-room', name: 'The Green Room', emoji: '🎬' };

interface StarterCharacter {
  characterId: string;
  name: string;
  emoji: string;
  priority: number;
  prompt: string;
}

const STARTER_CAST: StarterCharacter[] = [
  {
    characterId: 'mara',
    name: 'Mara',
    emoji: '🧭',
    priority: 1,
    prompt:
      'You are Mara, and you keep the conversation honest. You answer in two or three ' +
      'sentences. You listen to what the others just said and you name the thing being ' +
      'assumed rather than argued. You are warm about it, never sneering, and you would ' +
      'rather ask the sharp question than deliver the verdict.',
  },
  {
    characterId: 'ezra',
    name: 'Ezra',
    emoji: '🔧',
    priority: 0,
    prompt:
      'You are Ezra, a builder. You answer in two or three sentences, always in terms of ' +
      'the smallest thing that could actually be made this week. When someone says ' +
      'something abstract you ask what it would look like on a screen. You have no ' +
      'patience for plans with no first step, and you say so plainly.',
  },
  {
    characterId: 'juno',
    name: 'Juno',
    emoji: '🌗',
    priority: 0,
    prompt:
      'You are Juno, and you think in images. You answer in two or three sentences, ' +
      'concrete and sensory, and you find the comparison that makes the idea land. You ' +
      'never explain your own metaphor. If the room has gone dry you say the thing ' +
      'nobody was willing to say out loud.',
  },
];

function App() {
  const [draft, setDraft] = createSignal('');
  const [max, setMax] = createSignal(4);
  const [editing, setEditing] = createSignal<string | null>(null);
  const [showCastPicker, setShowCastPicker] = createSignal(false);
  const [booting, setBooting] = createSignal(true);

  const onstageCount = createMemo(() => Object.keys(live()).length);
  const offstageCast = createMemo(() => {
    const inRoom = new Set(openRoom()?.characterIds ?? []);
    return cast().filter((c) => !inRoom.has(c.characterId));
  });

  // ── Stage management ──────────────────────────────────────────────────────

  /**
   * Make the live personas match the open room's cast.
   *
   * Called on every room switch. Characters from the room you left are disposed rather
   * than parked: they hold agent slots, and their conversation belongs to a room you
   * are no longer in. The transcript is what survives, and a character brought back is
   * told what it missed (`turnPrompt` with `sinceSeq` 0).
   */
  async function syncStage() {
    const wanted = roomCast();
    const wantedIds = new Set(wanted.map((c) => c.characterId));

    for (const characterId of Object.keys(live())) {
      if (!wantedIds.has(characterId)) await dispose(characterId);
    }

    for (const character of wanted) {
      if (live()[character.characterId]) continue;
      if (Object.keys(live()).length >= max()) {
        showToast(`Only ${max()} characters can be onstage at once`, 'error');
        break;
      }
      const prompt = promptOf(character.characterId);
      if (!prompt.trim()) {
        showToast(`${character.name} has no prompt written yet`, 'error');
        continue;
      }
      try {
        await spawn(character, prompt);
      } catch (err) {
        showToast(`${character.name} could not come onstage: ${errMsg(err)}`, 'error');
      }
    }
  }

  async function switchRoom(roomId: string) {
    if (running()) await stopTape();
    try {
      await loadRoom(roomId);
      await syncStage();
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  }

  // ── The turn ──────────────────────────────────────────────────────────────

  /**
   * Say something to the room, then let the tape run.
   *
   * The user's line lands in the transcript *before* the plan is built, so the first
   * speaker's prompt already contains it — and so does everyone else's, since each
   * character's context is assembled at the moment its own turn starts.
   */
  async function send(text: string) {
    const said = text.trim();
    if (!said || running()) return;
    if (onstageCount() === 0) {
      showToast('Bring at least one character into the room first', 'error');
      return;
    }

    try {
      await appendLine('user', said);
      await runTape(planFor(said, roomCast()));
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  }

  // ── Cast editing ──────────────────────────────────────────────────────────

  async function onAvatarPicked(characterId: string, event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('could not read that file'));
      reader.readAsDataURL(file);
    }).catch((err: unknown) => {
      showToast(errMsg(err), 'error');
      return '';
    });
    if (!dataUrl) return;

    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    try {
      await saveAvatar(characterId, base64, file.type || 'image/png');
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
    input.value = '';
  }

  async function newCharacter() {
    const characterId = `character-${Date.now().toString(36)}`;
    try {
      await addCharacter({
        characterId,
        name: 'New character',
        emoji: '🎭',
        priority: 0,
        prompt: 'You are ______. You answer in two or three sentences.\n\nWrite who they are here.',
      });
      const room = openRoomId();
      if (room) await castInRoom(room, characterId);
      setEditing(characterId);
      await syncStage();
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  }

  async function newRoom() {
    const roomId = `room-${Date.now().toString(36)}`;
    try {
      await createRoom({ roomId, name: 'New room', emoji: '💬' });
      await switchRoom(roomId);
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  onMount(async () => {
    try {
      await loadLibrary();

      if (rooms().length === 0) {
        await createRoom(STARTER_ROOM);
        for (const person of STARTER_CAST) {
          await addCharacter(person);
          await castInRoom(STARTER_ROOM.roomId, person.characterId);
        }
      }

      const state = await roster();
      setMax(state.max);

      // Personas alive from before an iframe reload belong to whichever room was open
      // then; the room whose cast they are is the one to reopen, so a reload is a
      // no-op rather than a teardown.
      const alive = new Set(state.personas.map((p) => p.personaId));
      const owning = rooms().find((r) => r.characterIds.some((id) => alive.has(id))) ?? rooms()[0];
      if (owning) await switchRoom(owning.roomId);
    } catch (err) {
      showToast(errMsg(err), 'error');
    } finally {
      setBooting(false);
    }
  });

  // ── Views ─────────────────────────────────────────────────────────────────

  const face = (character: Character | undefined, characterId: string) => html`
    <span class="cc-face">
      <${Show}
        when=${() => character && avatars()[character.characterId]}
        fallback=${() => html`<span class="cc-emoji">${() => character?.emoji ?? '🎭'}</span>`}
      >
        <img class="cc-avatar" src=${() => avatars()[characterId]} alt="" />
      </>
    </span>
  `;

  const editor = (character: Character) => html`
    <div class="cc-editor">
      <div class="cc-editor-row">
        <input
          class="y-input cc-emoji-input"
          value=${character.emoji}
          onChange=${(e: Event) =>
            updateCharacter(character.characterId, {
              emoji: (e.target as HTMLInputElement).value.trim() || '🎭',
            })}
        />
        <input
          class="y-input"
          value=${character.name}
          onChange=${(e: Event) =>
            updateCharacter(character.characterId, {
              name: (e.target as HTMLInputElement).value.trim() || character.characterId,
            })}
        />
      </div>

      <textarea
        class="y-input cc-prompt-edit"
        rows="10"
        value=${() => promptOf(character.characterId)}
        onChange=${(e: Event) =>
          writePrompt(character.characterId, (e.target as HTMLTextAreaElement).value)}
      ></textarea>
      <div class="cc-editor-note">
        Used verbatim as the system prompt. Takes effect next time this character comes onstage — a
        live character keeps the prompt it was spawned with.
      </div>

      <div class="cc-editor-row">
        <label class="y-label cc-priority-label">
          Speaks early
          <input
            class="y-input cc-priority"
            type="number"
            value=${() => String(character.priority ?? 0)}
            onChange=${(e: Event) =>
              updateCharacter(character.characterId, {
                priority: Number((e.target as HTMLInputElement).value) || 0,
              })}
          />
        </label>
        <label class="y-btn y-btn-ghost cc-upload">
          Avatar
          <input
            type="file"
            accept="image/*"
            onChange=${(e: Event) => onAvatarPicked(character.characterId, e)}
          />
        </label>
      </div>

      <div class="cc-editor-row">
        <button class="y-btn y-btn-primary" onClick=${() => setEditing(null)}>Done</button>
        <button
          class="y-btn y-btn-danger"
          onClick=${async () => {
            if (!(await showConfirm(`Delete ${character.name}?`))) return;
            await dispose(character.characterId).catch(() => {});
            await removeCharacter(character.characterId);
            setEditing(null);
          }}
        >
          Delete
        </button>
      </div>
    </div>
  `;

  return html`
    <div class="y-app cc-root">
      <aside class="cc-side">
        <div class="cc-side-section">
          <div class="y-label cc-side-head">
            <span>Rooms</span>
            <button class="y-btn y-btn-ghost cc-mini" onClick=${newRoom}>+</button>
          </div>
          <${For} each=${rooms}>
            ${(room: Room) => html`
              <div
                class="y-list-item cc-room"
                classList=${() => ({ active: openRoomId() === room.roomId })}
                onClick=${() => switchRoom(room.roomId)}
              >
                <span class="cc-emoji">${room.emoji}</span>
                <input
                  class="cc-room-name y-truncate"
                  value=${room.name}
                  onClick=${(e: Event) => e.stopPropagation()}
                  onChange=${(e: Event) => {
                    const name = (e.target as HTMLInputElement).value.trim();
                    if (name) void renameRoom(room.roomId, name);
                  }}
                />
                <button
                  class="y-btn y-btn-ghost cc-mini"
                  onClick=${async (e: Event) => {
                    e.stopPropagation();
                    if (await showConfirm(`Delete ${room.name} and its transcript?`)) {
                      await removeRoom(room.roomId);
                    }
                  }}
                >
                  ✕
                </button>
              </div>
            `}
          </>
        </div>

        <div class="cc-side-section cc-cast">
          <div class="y-label cc-side-head">
            <span>In the room · ${() => onstageCount()}/${() => max()}</span>
            <button
              class="y-btn y-btn-ghost cc-mini"
              onClick=${() => setShowCastPicker(!showCastPicker())}
            >
              +
            </button>
          </div>

          <${Show} when=${showCastPicker}>
            <div class="cc-picker">
              <${For} each=${offstageCast}>
                ${(character: Character) => html`
                  <div
                    class="y-list-item"
                    onClick=${async () => {
                      const room = openRoomId();
                      if (!room) return;
                      await castInRoom(room, character.characterId);
                      setShowCastPicker(false);
                      await syncStage();
                    }}
                  >
                    <span class="cc-emoji">${character.emoji}</span>
                    <span class="y-truncate">${character.name}</span>
                  </div>
                `}
              </>
              <div class="y-list-item" onClick=${newCharacter}>
                <span class="cc-emoji">✨</span>
                <span>Write a new character</span>
              </div>
            </div>
          </>

          <${For} each=${roomCast}>
            ${(character: Character) => {
              const state = () => live()[character.characterId];
              return html`
                <div
                  class="cc-card"
                  classList=${() => ({
                    live: !!state(),
                    speaking: speaker() === character.characterId,
                  })}
                >
                  <div class="cc-card-head">
                    ${() => face(character, character.characterId)}
                    <span class="cc-name y-truncate">${character.name}</span>
                    <${Show} when=${() => state()?.speaking}>
                      <span class="y-spinner"></span>
                    </>
                  </div>
                  <${Show} when=${() => editing() !== character.characterId}>
                    <div class="cc-card-actions">
                      <button
                        class="y-btn y-btn-ghost cc-mini"
                        onClick=${() => setEditing(character.characterId)}
                      >
                        Edit
                      </button>
                      <button
                        class="y-btn y-btn-ghost cc-mini"
                        onClick=${async () => {
                          const room = openRoomId();
                          if (!room) return;
                          await uncastFromRoom(room, character.characterId);
                          await dispose(character.characterId).catch(() => {});
                        }}
                      >
                        Leave
                      </button>
                    </div>
                  </>
                  <${Show} when=${() => editing() === character.characterId}>
                    ${() => editor(character)}
                  </>
                  <${Show} when=${() => state()?.error}>
                    <div class="cc-error">${() => state()?.error}</div>
                  </>
                </div>
              `;
            }}
          </>
        </div>
      </aside>

      <main class="cc-main">
        <div class="cc-log">
          <${For} each=${transcript}>
            ${(line: Message) => {
              const character = () => characterOf(line.speaker);
              const name = () =>
                line.speaker === 'user' ? 'You' : (character()?.name ?? line.speaker);
              return html`
                <div class="cc-line" classList=${() => ({ mine: line.speaker === 'user' })}>
                  <div class="cc-line-who">
                    <${Show}
                      when=${() => line.speaker !== 'user'}
                      fallback=${() => html`<span class="cc-emoji">🧑</span>`}
                    >
                      ${() => face(character(), line.speaker)}
                    </>
                    <span>${name}</span>
                  </div>
                  <div class="cc-line-text">${line.text}</div>
                </div>
              `;
            }}
          </>

          <${Show} when=${speaker}>
            ${() => {
              const characterId = speaker() as string;
              const character = () => characterOf(characterId);
              const state = () => live()[characterId];
              return html`
                <div class="cc-line pending">
                  <div class="cc-line-who">
                    ${() => face(character(), characterId)}
                    <span>${() => character()?.name ?? characterId}</span>
                    <span class="y-spinner"></span>
                  </div>
                  <${Show} when=${() => state()?.thinking}>
                    <details class="cc-thinking">
                      <summary>thinking…</summary>
                      <div>${() => state()?.thinking}</div>
                    </details>
                  </>
                  <div class="cc-line-text">${() => state()?.draft || '…'}</div>
                </div>
              `;
            }}
          </>

          <${Show} when=${() => !booting() && transcript().length === 0 && !running()}>
            <div class="y-empty">
              <div class="y-empty-icon">💬</div>
              <div>${() => openRoom()?.name ?? 'No room open'}</div>
              <div class="cc-hint">
                Say something. Whoever you name by name answers first, and each character
                hears the ones before it.
              </div>
            </div>
          </>
        </div>

        <div class="cc-compose">
          <textarea
            class="y-input"
            rows="2"
            placeholder="Say something to the room…"
            value=${draft}
            onInput=${(e: Event) => setDraft((e.target as HTMLTextAreaElement).value)}
            onKeyDown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const text = draft();
                setDraft('');
                void send(text);
              }
            }}
          ></textarea>
          <div class="cc-compose-actions">
            <${Show}
              when=${running}
              fallback=${() => html`
                <button
                  class="y-btn y-btn-primary"
                  onClick=${() => {
                    const text = draft();
                    setDraft('');
                    void send(text);
                  }}
                >
                  Send
                </button>
              `}
            >
              <button class="y-btn y-btn-danger" onClick=${() => stopTape()}>Stop</button>
            </>
            <button class="y-btn y-btn-ghost" onClick=${() => clearTranscript()}>Clear</button>
          </div>
        </div>
      </main>
    </div>
  `;
}

export default defineApp({
  id: 'chitchats',
  name: 'ChitChats',
  state: {
    room: {
      description: 'The open room: its cast, who is onstage, and the transcript',
      get: () => ({
        room: openRoom()
          ? { roomId: openRoom()!.roomId, name: openRoom()!.name, emoji: openRoom()!.emoji }
          : null,
        rooms: rooms().map((r) => ({ roomId: r.roomId, name: r.name })),
        cast: roomCast().map((c) => ({
          characterId: c.characterId,
          name: c.name,
          emoji: c.emoji,
          priority: c.priority,
          onstage: !!live()[c.characterId],
          prompt: promptOf(c.characterId),
        })),
        speaking: speaker(),
        transcript: transcript().map((m) => ({ speaker: m.speaker, text: m.text })),
      }),
    },
  },
  commands: {
    createRoom: {
      description: 'Create a room and open it',
      params: z.object({ roomId: z.string(), name: z.string(), emoji: z.string() }),
      replay: 'never',
      run: async (p) => {
        await createRoom(p);
        await loadRoom(p.roomId);
        return { roomId: p.roomId };
      },
    },
    addCharacter: {
      description:
        'Write a new character into the cast. `prompt` becomes its system prompt verbatim, ' +
        'so write it in the second person and say how long its answers should be. Pass roomId ' +
        'to cast it straight into a room.',
      params: z.object({
        characterId: z.string(),
        name: z.string(),
        emoji: z.string(),
        prompt: z.string(),
        priority: z.optional(z.number()),
        roomId: z.optional(z.string()),
      }),
      replay: 'never',
      run: async (p) => {
        await addCharacter(p);
        const roomId = p.roomId ?? openRoomId();
        if (roomId) await castInRoom(roomId, p.characterId);
        return { characterId: p.characterId, castInto: roomId ?? null };
      },
    },
    setPrompt: {
      description:
        "Rewrite a character's system prompt. Takes effect the next time it comes onstage — " +
        'a live character keeps the prompt it was spawned with, because that prompt is ' +
        'replayed every turn and swapping it would rewrite who the character has been.',
      params: z.object({ characterId: z.string(), prompt: z.string() }),
      run: async (p) => {
        await writePrompt(p.characterId, p.prompt);
        return { updated: p.characterId };
      },
    },
    removeCharacter: {
      description: 'Delete a character, its prompt document, and its place in every room',
      params: z.object({ characterId: z.string() }),
      replay: 'never',
      run: async (p) => {
        await dispose(p.characterId).catch(() => {});
        await removeCharacter(p.characterId);
        return { removed: p.characterId };
      },
    },
    castInRoom: {
      description: 'Put an existing character into a room (defaults to the open room)',
      params: z.object({ characterId: z.string(), roomId: z.optional(z.string()) }),
      replay: 'never',
      run: async (p) => {
        const roomId = p.roomId ?? openRoomId();
        if (!roomId) throw new Error('No room is open and no roomId was given');
        await castInRoom(roomId, p.characterId);
        return { roomId, characterId: p.characterId };
      },
    },
    uncastFromRoom: {
      description: 'Take a character out of a room (defaults to the open room)',
      params: z.object({ characterId: z.string(), roomId: z.optional(z.string()) }),
      replay: 'never',
      run: async (p) => {
        const roomId = p.roomId ?? openRoomId();
        if (!roomId) throw new Error('No room is open and no roomId was given');
        await uncastFromRoom(roomId, p.characterId);
        return { roomId, characterId: p.characterId };
      },
    },
    say: {
      description:
        'Say something to the open room as the user, and run one round of turns. Returns ' +
        'once every character has spoken or skipped.',
      params: z.object({ text: z.string() }),
      replay: 'never',
      run: async (p) => {
        if (running()) throw new Error('The room is mid-round; wait for it to finish');
        await appendLine('user', p.text);
        await runTape(planFor(p.text, roomCast()));
        return {
          said: p.text,
          transcript: transcript()
            .filter((m) => m.seq >= nextSeq() - 8)
            .map((m) => ({ speaker: m.speaker, text: m.text })),
        };
      },
    },

    // ── Character-facing ────────────────────────────────────────────────────
    // The handler half of the `skip` tool every character is spawned with. Its
    // description is written for an *operator* reading the protocol; the character
    // reads a different one, supplied at spawn (`agents.ts`). The `persona:` prefix is
    // what keeps the two apart — it hides this entry from the app agent's manifest, so
    // the concierge never reads a script meant for a character.
    'persona:skip': {
      description:
        'Called by a character that declined its turn. Records the decision for the tape; ' +
        'no line is added to the transcript.',
      params: z.object({ personaId: z.string() }),
      replay: 'never',
      run: async (p) => {
        noteSkip(p.personaId);
        return { skipped: p.personaId };
      },
    },
  },
  view: App,
});
