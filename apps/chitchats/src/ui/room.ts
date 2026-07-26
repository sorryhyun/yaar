/**
 * The right column: the transcript, the line being spoken right now, and the compose box.
 *
 * Returns the whole `<main>`, the second grid child of `.cc-root`.
 */

import { For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';

import { transcript, characterOf, openRoom, clearTranscript, type Message } from '../store';
import { running, speaker, stopTape } from '../tape';
import { live } from '../agents';
import { draft, setDraft, booting } from './state';
import { face } from './views';
import { send } from '../stage';

export function roomPane() {
  return html`
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
  `;
}
