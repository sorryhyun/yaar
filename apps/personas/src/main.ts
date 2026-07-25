import { createSignal, createMemo, For, Show, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { defineApp, showToast, errMsg } from '@bundled/yaar';
import * as z from '@bundled/zod';

import {
  cast,
  transcript,
  loadRoom,
  addCharacter,
  removeCharacter,
  updateCharacter,
  appendLine,
  clearTranscript,
  turnPrompt,
  nextSeq,
  type Character,
} from './store';
import { live, spawn, say, interrupt, dispose, roster } from './agents';
import './styles.css';

const STARTER_CAST: Array<Pick<Character, 'characterId' | 'name' | 'emoji' | 'prompt'>> = [
  {
    characterId: 'skeptic',
    name: 'Vera',
    emoji: '🧐',
    prompt:
      'You are Vera, a relentless skeptic. You answer in two or three sentences. You look for the ' +
      'assumption nobody stated and name it. You are never rude, but you never agree just to be agreeable.',
  },
  {
    characterId: 'builder',
    name: 'Kit',
    emoji: '🔧',
    prompt:
      'You are Kit, a builder. You answer in two or three sentences and always in terms of the ' +
      'smallest thing that could be made this week. You dislike abstractions with no artifact attached.',
  },
  {
    characterId: 'poet',
    name: 'Sol',
    emoji: '🌗',
    prompt:
      'You are Sol, who thinks in images. You answer in two or three sentences, concrete and sensory, ' +
      'and you find the metaphor that makes the idea land. You never explain your own metaphor.',
  },
];

function App() {
  const [draft, setDraft] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [editing, setEditing] = createSignal<string | null>(null);
  const [max, setMax] = createSignal(4);

  const spawnedCount = createMemo(() => Object.keys(live()).length);
  const anySpeaking = createMemo(() => Object.values(live()).some((l) => l.speaking));

  /**
   * A character finished. Its answer joins the transcript, so the *next* round the
   * others are told what it said — which is the whole trick behind characters that
   * appear to talk to each other rather than past each other.
   */
  async function onAnswer(characterId: string, text: string) {
    try {
      await appendLine(characterId, text);
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  }

  async function bringOnstage(character: Character) {
    try {
      await spawn(character, onAnswer);
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  }

  async function send() {
    const text = draft().trim();
    if (!text || busy()) return;
    const speaking = Object.entries(live());
    if (speaking.length === 0) {
      showToast('Bring at least one character onstage first', 'error');
      return;
    }

    setBusy(true);
    try {
      setDraft('');
      await appendLine('user', text);
      const upTo = nextSeq() - 1;
      // Fired together, deliberately not awaited in sequence: each `say` returns as
      // soon as its turn is queued, so every character is generating at once.
      await Promise.all(
        speaking.map(([characterId, state]) => {
          const character = cast().find((c) => c.characterId === characterId);
          if (!character) return Promise.resolve();
          return say(characterId, turnPrompt(character, state.lastSeq), upTo);
        }),
      );
    } catch (err) {
      showToast(errMsg(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function stopEveryone() {
    for (const [characterId, state] of Object.entries(live())) {
      if (state.speaking) await interrupt(characterId).catch(() => {});
    }
  }

  async function addStarterCast() {
    try {
      for (const person of STARTER_CAST) {
        if (!cast().some((c) => c.characterId === person.characterId)) {
          await addCharacter(person);
        }
      }
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  }

  onMount(async () => {
    try {
      await loadRoom();
      const state = await roster();
      setMax(state.max);
      // Personas already alive from before an iframe reload — reattach their streams
      // rather than respawning, so nobody loses the conversation they were in.
      for (const person of state.personas) {
        const character = cast().find((c) => c.characterId === person.personaId);
        if (character) await bringOnstage(character);
      }
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  });

  return html`
    <div class="y-app rt-root">
      <div class="rt-cast">
        <div class="y-label">
          Cast · ${() => spawnedCount()}/${() => max()} onstage
        </div>

        <${For} each=${cast}>
          ${(character: Character) => {
            const state = () => live()[character.characterId];
            return html`
              <div class="rt-card" classList=${() => ({ active: !!state() })}>
                <div class="rt-card-head">
                  <span class="rt-emoji">${character.emoji}</span>
                  <span class="rt-name y-truncate">${character.name}</span>
                  <${Show} when=${() => state()?.speaking}>
                    <span class="y-spinner rt-spin"></span>
                  </>
                </div>

                <${Show}
                  when=${() => editing() === character.characterId}
                  fallback=${() =>
                    html`<div class="rt-prompt y-clamp-3">${character.prompt}</div>`}
                >
                  <textarea
                    class="y-input rt-prompt-edit"
                    rows="6"
                    value=${character.prompt}
                    onChange=${(e: Event) =>
                      updateCharacter(character.characterId, {
                        prompt: (e.target as HTMLTextAreaElement).value,
                      })}
                  ></textarea>
                </>

                <div class="rt-card-actions">
                  <${Show}
                    when=${() => state()}
                    fallback=${() => html`
                      <button
                        class="y-btn y-btn-primary"
                        disabled=${() => spawnedCount() >= max()}
                        onClick=${() => bringOnstage(character)}
                      >
                        Onstage
                      </button>
                    `}
                  >
                    <button class="y-btn y-btn-ghost" onClick=${() => dispose(character.characterId)}>
                      Offstage
                    </button>
                  </>
                  <button
                    class="y-btn y-btn-ghost"
                    onClick=${() =>
                      setEditing(editing() === character.characterId ? null : character.characterId)}
                  >
                    ${() => (editing() === character.characterId ? 'Done' : 'Prompt')}
                  </button>
                  <button
                    class="y-btn y-btn-danger"
                    onClick=${async () => {
                      if (live()[character.characterId]) await dispose(character.characterId);
                      await removeCharacter(character.characterId);
                    }}
                  >
                    ✕
                  </button>
                </div>

                <${Show} when=${() => state()?.error}>
                  <div class="rt-error">${() => state()?.error}</div>
                </>
              </div>
            `;
          }}
        </>

        <${Show} when=${() => cast().length === 0}>
          <div class="y-empty">
            <div class="y-empty-icon">🎭</div>
            <div>No characters yet.</div>
            <button class="y-btn y-btn-primary" onClick=${addStarterCast}>Add a starter cast</button>
          </div>
        </>
      </div>

      <div class="rt-room">
        <div class="rt-log">
          <${For} each=${transcript}>
            ${(line) => {
              const who = () =>
                line.speaker === 'user'
                  ? { emoji: '🧑', name: 'You' }
                  : (cast().find((c) => c.characterId === line.speaker) ?? {
                      emoji: '🎭',
                      name: line.speaker,
                    });
              return html`
                <div class="rt-line" classList=${() => ({ mine: line.speaker === 'user' })}>
                  <div class="rt-line-who">
                    <span class="rt-emoji">${() => who().emoji}</span>
                    <span>${() => who().name}</span>
                  </div>
                  <div class="rt-line-text">${line.text}</div>
                </div>
              `;
            }}
          </>

          <${For} each=${() => Object.entries(live()).filter(([, s]) => s.speaking)}>
            ${(entry) => {
              const [characterId, state] = entry as [string, ReturnType<typeof live>[string]];
              const character = () => cast().find((c) => c.characterId === characterId);
              const current = () => live()[characterId];
              return html`
                <div class="rt-line pending">
                  <div class="rt-line-who">
                    <span class="rt-emoji">${() => character()?.emoji ?? '🎭'}</span>
                    <span>${() => character()?.name ?? characterId}</span>
                    <span class="y-spinner rt-spin"></span>
                  </div>
                  <${Show} when=${() => current()?.thinking}>
                    <details class="rt-thinking">
                      <summary>thinking…</summary>
                      <div>${() => current()?.thinking}</div>
                    </details>
                  </>
                  <div class="rt-line-text">${() => current()?.draft || '…'}</div>
                </div>
              `;
            }}
          </>

          <${Show} when=${() => transcript().length === 0 && !anySpeaking()}>
            <div class="y-empty">
              <div class="y-empty-icon">💬</div>
              <div>Bring characters onstage, then say something.</div>
              <div class="rt-hint">
                Each one is its own agent with its own memory. They answer at the same time.
              </div>
            </div>
          </>
        </div>

        <div class="rt-compose">
          <textarea
            class="y-input"
            rows="2"
            placeholder="Say something to the room…"
            value=${draft}
            onInput=${(e: Event) => setDraft((e.target as HTMLTextAreaElement).value)}
            onKeyDown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          ></textarea>
          <div class="rt-compose-actions">
            <button class="y-btn y-btn-primary" disabled=${busy} onClick=${send}>Send</button>
            <${Show} when=${anySpeaking}>
              <button class="y-btn y-btn-ghost" onClick=${stopEveryone}>Stop</button>
            </>
            <button class="y-btn y-btn-ghost" onClick=${clearTranscript}>Clear</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

export default defineApp({
  id: 'personas',
  name: 'Round Table',
  state: {
    room: {
      description: 'The cast, who is onstage, and the transcript',
      get: () => ({
        cast: cast().map((c) => ({ characterId: c.characterId, name: c.name, emoji: c.emoji })),
        onstage: Object.entries(live()).map(([characterId, s]) => ({
          characterId,
          speaking: s.speaking,
        })),
        transcript: transcript().map((l) => ({ speaker: l.speaker, text: l.text })),
      }),
    },
  },
  commands: {
    addCharacter: {
      description: 'Write a new character into the cast (does not bring it onstage)',
      params: z.object({
        characterId: z.string(),
        name: z.string(),
        emoji: z.string(),
        prompt: z.string(),
      }),
      // Writes a row — replaying it on remount would duplicate the character.
      replay: 'never',
      run: async (p) => {
        await addCharacter(p as Pick<Character, 'characterId' | 'name' | 'emoji' | 'prompt'>);
        return { added: p.characterId };
      },
    },
    removeCharacter: {
      description: 'Remove a character from the cast',
      params: z.object({ characterId: z.string() }),
      replay: 'never',
      run: async (p) => {
        await removeCharacter(p.characterId);
        return { removed: p.characterId };
      },
    },
    setPrompt: {
      description: "Rewrite a character's system prompt (takes effect next time it goes onstage)",
      params: z.object({ characterId: z.string(), prompt: z.string() }),
      run: async (p) => {
        await updateCharacter(p.characterId, { prompt: p.prompt });
        return { updated: p.characterId };
      },
    },
  },
  view: App,
});
