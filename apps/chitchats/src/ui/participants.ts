/**
 * The right overlay sidebar: who is in the open room right now.
 *
 * This is the cast list that used to sit under the room list on the left. It shows only
 * the characters the open room has cast — live state, who is speaking, and the way out
 * of the room. Adding somebody is a library operation, so the plus here just reveals the
 * left sidebar rather than growing a second picker.
 *
 * `onstageCount` arrives as an accessor rather than being imported: it is a memo, a memo
 * needs a reactive owner, and `App()` is the only place in this app that has one.
 */

import { For, Show, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';

import { roomCast, openRoomId, uncastFromRoom, type Character } from '../store';
import { speaker } from '../tape';
import { live, dispose } from '../agents';
import { max, setEditing } from './state';
import { face } from './views';
import {
  participantsExpanded,
  participantsPinned,
  openParticipants,
  scheduleParticipantsClose,
  cancelParticipantsClose,
  toggleParticipantsPin,
  openCharacters,
} from './panels';

export interface ParticipantsContext {
  onstageCount: () => number;
}

export function participantsSidebar(ctx: ParticipantsContext) {
  onCleanup(cancelParticipantsClose);

  return html`
    <aside
      class="cc-side cc-side-right"
      classList=${() => ({
        expanded: participantsExpanded(),
        pinned: participantsPinned(),
      })}
      onMouseEnter=${openParticipants}
      onMouseLeave=${scheduleParticipantsClose}
    >
      <div class="cc-edge cc-edge-right" title="In the room"></div>
      <div class="cc-panel">
        <div class="cc-panel-head">
          <span class="y-label">In the room · ${() => ctx.onstageCount()}/${() => max()}</span>
          <button
            class="cc-pin"
            classList=${() => ({ active: participantsPinned() })}
            title=${() => (participantsPinned() ? 'Unpin this panel' : 'Keep this panel open')}
            onClick=${() => toggleParticipantsPin()}
          >
            📌
          </button>
        </div>

        <div class="cc-panel-cast">
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
                  <div class="cc-card-actions">
                    <button
                      class="y-btn y-btn-ghost cc-mini"
                      title="Edit this character in the library"
                      onClick=${() => {
                        setEditing(character.characterId);
                        openCharacters();
                      }}
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
                  <${Show} when=${() => state()?.error}>
                    <div class="cc-error">${() => state()?.error}</div>
                  </>
                </div>
              `;
            }}
          </>

          <${Show} when=${() => roomCast().length === 0}>
            <div class="cc-hint cc-empty-cast">
              Nobody is here yet. Open <strong>Characters</strong> on the left and add
              somebody to the room.
            </div>
          </>

          <button class="y-btn y-btn-ghost cc-add-someone" onClick=${openCharacters}>
            + Add someone
          </button>
        </div>
      </div>
    </aside>
  `;
}
