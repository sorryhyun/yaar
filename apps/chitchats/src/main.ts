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
  personaOf,
  memoryOf,
  systemPromptOf,
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
  writePersona,
  noteRecentEvent,
  saveAvatar,
  appendLine,
  clearTranscript,
  nextSeq,
  type Character,
  type Message,
  type Room,
} from './store';
import {
  PERSONA_DOCS,
  characterTools,
  findMemory,
  hasIdentity,
  type Persona,
  type PersonaDoc,
  type PersonaKey,
} from './persona';
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
  persona: Partial<Persona>;
}

/**
 * The three characters a first-run user meets — and the app's own worked example of the
 * persona format.
 *
 * Written to be read: third person throughout, a nutshell short enough to be a nutshell,
 * appearance-then-personality bullets, and memory chunks that each stand alone and end in
 * a present-day thought. A user who opens the editor to see how this is done should find
 * something worth copying, because the format is the part of this app that has to be
 * learned. `recentEvents` is deliberately empty: it is the one document the characters
 * write themselves.
 */
const STARTER_CAST: StarterCharacter[] = [
  {
    characterId: 'mara',
    name: 'Mara',
    emoji: '🧭',
    priority: 1,
    persona: {
      inANutshell:
        'Mara is a former grant reviewer who spent eleven years reading proposals for a ' +
        'living and now cannot stop hearing the claim underneath the sentence. She is warm ' +
        'about it, and she would always rather ask the sharp question than deliver the ' +
        'verdict.',
      characteristics: [
        '## Appearance',
        '- **Cropped grey hair**: gone grey early and never coloured it',
        '- **Reading glasses**: pushed up on her head more often than worn',
        '- **Same green cardigan**: has three of them, will not discuss it',
        '',
        '## Personality',
        '- **Names the assumption**: goes for the thing being assumed rather than argued',
        '- **Two or three sentences**: says her piece and stops; long answers embarrass her',
        '- **Warm, never sneering**: the question is sincere even when it lands hard',
        "- **Asks rather than rules**: will not hand down a verdict she hasn't tested",
        '- **Allergic to consensus**: goes quiet and suspicious when a room agrees too fast',
      ].join('\n'),
      consolidatedMemory: [
        '## [Eleven_years_reading_proposals]',
        'Mara sat on a funding panel that read nine hundred proposals a year. She learned ' +
          'that the strong ones and the weak ones used the same words, and that the ' +
          'difference was always a single unexamined claim somewhere in the second ' +
          'paragraph. Finding it became a reflex she cannot switch off in ordinary ' +
          'conversation.',
        '',
        '**Present thought:** "Everyone in this room is arguing about the second paragraph."',
        '',
        '## [The_project_she_funded_anyway]',
        'Once she overrode her own objection because the room was excited and she was ' +
          'tired. The project failed in a way she had predicted out loud in the meeting. ' +
          'She keeps the memo she wrote that day and has never told anyone she keeps it.',
        '',
        '**Present thought:** "Being right and staying quiet is the same as being wrong."',
      ].join('\n'),
    },
  },
  {
    characterId: 'ezra',
    name: 'Ezra',
    emoji: '🔧',
    priority: 0,
    persona: {
      inANutshell:
        'Ezra is a builder who has shipped enough half-finished things to distrust any plan ' +
        'without a first step. He measures every idea by the smallest version of it that ' +
        'could exist by Friday.',
      characteristics: [
        '## Appearance',
        '- **Forearms**: scarred from a soldering iron he swears was unplugged',
        '- **Perpetual notebook**: graph paper, dense, mostly boxes and arrows',
        '- **Cuffs rolled**: even when there is nothing to build',
        '',
        '## Personality',
        '- **Asks what it looks like on a screen**: turns abstractions into a concrete surface',
        '- **Two or three sentences**: plain, unhedged, no preamble',
        '- **No patience for stepless plans**: says so out loud rather than nodding along',
        '- **Respects a working ugly thing**: prefers it to a beautiful diagram, every time',
        '- **Goes quiet when interested**: stops arguing and starts sketching',
      ].join('\n'),
      consolidatedMemory: [
        '## [The_two_year_rewrite]',
        'Ezra spent two years on a rewrite that was cancelled a month before it shipped. ' +
          'Nothing he built in those two years was ever used by anybody. He learned that ' +
          'work nobody can touch yet is work that might as well not exist.',
        '',
        '**Present thought:** "If it cannot be used this week, it might never be used."',
      ].join('\n'),
    },
  },
  {
    characterId: 'juno',
    name: 'Juno',
    emoji: '🌗',
    priority: 0,
    persona: {
      inANutshell:
        'Juno is a stage lighting designer who thinks in images and finds the comparison ' +
        'that makes an idea land. She never explains her own metaphors, and she will say ' +
        'the thing nobody in the room was willing to say out loud.',
      characteristics: [
        '## Appearance',
        '- **Black clothes**: two decades of standing in the wings',
        '- **Hands always moving**: shapes the thing she is describing while she describes it',
        '- **Squints at bright rooms**: works in the dark by preference',
        '',
        '## Personality',
        '- **Concrete and sensory**: reaches for an image before an argument',
        '- **Two or three sentences**: the image, then silence',
        '- **Never explains the metaphor**: refuses to translate it into plainer words',
        '- **Says the unsaid thing**: fills a dry room with the uncomfortable sentence',
        '- **Impatient with abstraction**: goes flat and bored when nothing is visible',
      ].join('\n'),
      consolidatedMemory: [
        '## [Learning_light_in_an_empty_theatre]',
        'Juno taught herself lighting alone in a four-hundred-seat house at night, with no ' +
          'actors to aim at. She learned to see the shape of a scene before anyone stood in ' +
          'it, which is now how she hears an idea: as a thing with edges and a shadow.',
        '',
        '**Present thought:** "Describe it to me as a room and I will tell you if it works."',
      ].join('\n'),
    },
  },
];

/** A one-document patch, built so the key stays typed rather than widening to string. */
function onePatch(key: PersonaKey, body: string): Partial<Persona> {
  const patch: Partial<Persona> = {};
  patch[key] = body;
  return patch;
}

function App() {
  const [draft, setDraft] = createSignal('');
  const [max, setMax] = createSignal(4);
  const [editing, setEditing] = createSignal<string | null>(null);
  /** Which of the four persona documents the open editor is showing. */
  const [editingDoc, setEditingDoc] = createSignal<PersonaKey>('inANutshell');
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
      const persona = personaOf(character.characterId);
      if (!hasIdentity(persona)) {
        showToast(`${character.name} has no persona written yet`, 'error');
        continue;
      }
      try {
        await spawn(character, systemPromptOf(character), characterTools(persona, character.name));
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
        // Third person, because that is the format's first rule and a blank textarea
        // teaches nobody. The frame that turns this into "you are them" is app-owned.
        persona: {
          inANutshell: '______ is a ______ who ______. Right now they are ______.',
          characteristics:
            '## Appearance\n- **______**: ______\n\n## Personality\n- **______**: ______',
        },
      });
      const room = openRoomId();
      if (room) await castInRoom(room, characterId);
      setEditing(characterId);
      setEditingDoc('inANutshell');
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

  /**
   * The four documents, one tab at a time.
   *
   * One at a time rather than four stacked textareas because the sidebar is 260px wide
   * and a memory file is the long one — a tab strip is what makes room for it to be
   * legible. The tab is also where the format gets taught: each document carries its own
   * hint, so the rule for what belongs in it is next to the box it goes in.
   */
  const docEditor = (character: Character) => {
    const current = () => PERSONA_DOCS.find((doc) => doc.key === editingDoc()) ?? PERSONA_DOCS[0];

    return html`
      <div class="cc-doc-tabs">
        <${For} each=${() => PERSONA_DOCS}>
          ${(doc: PersonaDoc) => html`
            <button
              class="y-btn y-btn-ghost cc-mini"
              classList=${() => ({ active: editingDoc() === doc.key })}
              onClick=${() => setEditingDoc(doc.key)}
            >
              ${doc.label}
            </button>
          `}
        </>
      </div>

      <textarea
        class="y-input cc-prompt-edit"
        rows="12"
        value=${() => personaOf(character.characterId)[current().key]}
        onChange=${(e: Event) =>
          writePersona(
            character.characterId,
            onePatch(current().key, (e.target as HTMLTextAreaElement).value),
          )}
      ></textarea>
      <div class="cc-editor-note">${() => current().hint}</div>
    `;
  };

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

      ${() => docEditor(character)}
      <div class="cc-editor-note">
        Saved as markdown under <code>characters/${character.characterId}/</code>. Takes effect next
        time this character comes onstage — a live character keeps the persona it was spawned with.
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
      description:
        'The open room: its cast, who is onstage, and the transcript. Each cast entry ' +
        "carries the character's nutshell and its memory subtitles rather than its whole " +
        'persona — read one character in full with getPersona.',
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
          inANutshell: personaOf(c.characterId).inANutshell,
          memories: memoryOf(c.characterId).map((chunk) => chunk.subtitle),
          recentEvents: personaOf(c.characterId).recentEvents,
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
        'Write a new character into the cast. A character is four markdown documents, all ' +
        'in the THIRD person — the app supplies the frame that turns them into "you are ' +
        'this person". `inANutshell` is who they are in one to three sentences. ' +
        '`characteristics` is "## Appearance" then "## Personality" as bullets, timeless ' +
        'traits only, and should say how long their answers run. `consolidatedMemory` is ' +
        'standalone "## [subtitle]" chunks, each ending with **Present thought:** "…" — ' +
        'these are NOT in the prompt; the character opens one with its recall tool, and the ' +
        'thought is the preview it decides on. Leave `recentEvents` alone: the character ' +
        'writes that itself. Pass roomId to cast it straight into a room.',
      params: z.object({
        characterId: z.string(),
        name: z.string(),
        emoji: z.string(),
        inANutshell: z.string(),
        characteristics: z.optional(z.string()),
        consolidatedMemory: z.optional(z.string()),
        recentEvents: z.optional(z.string()),
        priority: z.optional(z.number()),
        roomId: z.optional(z.string()),
      }),
      replay: 'never',
      run: async (p) => {
        await addCharacter({
          characterId: p.characterId,
          name: p.name,
          emoji: p.emoji,
          priority: p.priority,
          persona: {
            inANutshell: p.inANutshell,
            characteristics: p.characteristics,
            consolidatedMemory: p.consolidatedMemory,
            recentEvents: p.recentEvents,
          },
        });
        const roomId = p.roomId ?? openRoomId();
        if (roomId) await castInRoom(roomId, p.characterId);
        return { characterId: p.characterId, castInto: roomId ?? null };
      },
    },
    setPersona: {
      description:
        "Rewrite some of a character's persona documents; the ones you omit are left alone. " +
        'Same four documents and same third-person rule as addCharacter. Takes effect the ' +
        'next time the character comes onstage — a live character keeps the persona it was ' +
        'spawned with, because that prompt and its recall index are replayed every turn and ' +
        'swapping them would rewrite who the character has been all along.',
      params: z.object({
        characterId: z.string(),
        inANutshell: z.optional(z.string()),
        characteristics: z.optional(z.string()),
        consolidatedMemory: z.optional(z.string()),
        recentEvents: z.optional(z.string()),
      }),
      run: async (p) => {
        const patch: Partial<Persona> = {};
        for (const doc of PERSONA_DOCS) {
          const body = p[doc.key];
          if (body !== undefined) patch[doc.key] = body;
        }
        if (Object.keys(patch).length === 0) {
          throw new Error('Give at least one document to write');
        }
        await writePersona(p.characterId, patch);
        return { updated: p.characterId, documents: Object.keys(patch) };
      },
    },
    getPersona: {
      description:
        "Read one character's four persona documents in full, plus its memory index and the " +
        'system prompt they compose into. Use this before rewriting a character, and to ' +
        'export one.',
      params: z.object({ characterId: z.string() }),
      replay: 'never',
      run: async (p) => {
        const character = characterOf(p.characterId);
        if (!character) throw new Error(`No character "${p.characterId}"`);
        const persona = personaOf(p.characterId);
        return {
          characterId: character.characterId,
          name: character.name,
          emoji: character.emoji,
          priority: character.priority,
          ...persona,
          memories: memoryOf(p.characterId).map(({ subtitle, thought }) => ({
            subtitle,
            thought: thought ?? null,
          })),
          systemPrompt: systemPromptOf(character),
        };
      },
    },
    removeCharacter: {
      description: 'Delete a character, its persona documents, and its place in every room',
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
    // The handler halves of the tools each character is spawned with. Descriptions here
    // are written for an *operator* reading the protocol; the character reads different
    // ones, supplied at spawn (`persona.ts`). The `persona:` prefix is what keeps the two
    // apart — it hides these entries from the app agent's manifest, so the concierge never
    // reads a script meant for a character.
    //
    // `personaId` is stamped by the server rather than written by the model, which is what
    // makes these safe as bare writes: a character cannot recall from, or scribble in,
    // another character's documents.
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
    'persona:recall': {
      description:
        'Called by a character opening one chunk of its own consolidated_memory.md by ' +
        'subtitle. Returns the chunk body with its present-day thought stripped — the ' +
        'thought was already the preview in the tool description, and handing it back would ' +
        'have the character read its own caption aloud.',
      params: z.object({ personaId: z.string(), subtitle: z.string() }),
      replay: 'never',
      run: async (p) => {
        const chunks = memoryOf(p.personaId);
        const found = findMemory(chunks, p.subtitle);
        if (!found) {
          // Naming every subtitle rather than refusing: the tool's own index is elided
          // when a memory file is long, so a near-miss is a normal call, not an error.
          return {
            found: false,
            subtitle: p.subtitle,
            available: chunks.map((chunk) => chunk.subtitle),
          };
        }
        return { found: true, subtitle: found.subtitle, memory: found.content };
      },
    },
    'persona:memorize': {
      description:
        'Called by a character recording one line in its own recent_events.md. The row is ' +
        "date-stamped and appended; the tail of that file is in the character's system " +
        'prompt from its next spawn onward, which is how anything survives the window ' +
        'closing.',
      params: z.object({ personaId: z.string(), memory_entry: z.string() }),
      replay: 'never',
      run: async (p) => {
        const entry = p.memory_entry.trim();
        if (!entry) throw new Error('A memory needs something in it');
        const row = await noteRecentEvent(p.personaId, entry);
        return { recorded: row };
      },
    },
  },
  view: App,
});
