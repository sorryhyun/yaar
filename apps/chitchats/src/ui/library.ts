/**
 * The left overlay sidebar: every room, and the whole character library.
 *
 * This is the *library*, not the room — it lists every character that exists, whether
 * or not the open room has cast it, so "who could be here" is one list rather than a
 * picker hidden behind a plus button. Who is actually here lives in the right sidebar
 * (`participants.ts`).
 *
 * The character editor opens inside a library card rather than a participant card, for
 * the same reason: editing a character is a library operation, and keeping it on one
 * side means the single `editing` signal can never render two textareas over the same
 * documents.
 *
 * Reveal is the shared hover-expand machine (`panels.ts`): the cursor near the left edge
 * opens it, leaving folds it back, and the topbar's Characters button pins it open.
 */

import { For, Show, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { showConfirm } from '@bundled/yaar';

import {
  rooms,
  cast,
  openRoom,
  openRoomId,
  removeRoom,
  castInRoom,
  uncastFromRoom,
  type Character,
  type Room,
} from '../store';
import { live, dispose } from '../agents';
import { editing, setEditing, libraryView, setLibraryView } from './state';
import { face } from './views';
import { editor } from './editor';
import { switchRoom, newRoom, newCharacter, syncStage } from '../stage';
import {
  charactersExpanded,
  charactersPinned,
  openCharacters,
  scheduleCharactersClose,
  cancelCharactersClose,
  toggleCharactersPin,
} from './panels';

/** Whether the open room has this character cast. Read inside a tracking scope. */
const inOpenRoom = (characterId: string) =>
  (openRoom()?.characterIds ?? []).includes(characterId);

export function charactersSidebar() {
  onCleanup(cancelCharactersClose);

  return html`
    <aside
      class="cc-side cc-side-left"
      classList=${() => ({
        expanded: charactersExpanded(),
        pinned: charactersPinned(),
        'view-rooms': libraryView() === 'rooms',
        'view-characters': libraryView() === 'characters',
      })}
      onMouseEnter=${openCharacters}
      onMouseLeave=${scheduleCharactersClose}
    >
      <div class="cc-edge cc-edge-left" title="Characters"></div>
      <div class="cc-panel">
        <div class="cc-panel-head">
          <div class="cc-library-tabs" role="tablist" aria-label="Sidebar list">
            <button
              class="y-btn y-btn-ghost cc-library-tab"
              classList=${() => ({ active: libraryView() === 'rooms' })}
              aria-pressed=${() => libraryView() === 'rooms'}
              onClick=${() => setLibraryView('rooms')}
            >
              Rooms
            </button>
            <button
              class="y-btn y-btn-ghost cc-library-tab"
              classList=${() => ({ active: libraryView() === 'characters' })}
              aria-pressed=${() => libraryView() === 'characters'}
              onClick=${() => setLibraryView('characters')}
            >
              Characters
            </button>
          </div>
          <button
            class="cc-pin"
            classList=${() => ({ active: charactersPinned() })}
            title=${() => (charactersPinned() ? 'Unpin this panel' : 'Keep this panel open')}
            onClick=${() => toggleCharactersPin()}
          >
            📌
          </button>
        </div>

        <div class="cc-panel-rooms">
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
                <span class="cc-room-name y-truncate" title=${room.name}>${room.name}</span>
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

        <div class="cc-panel-library">
          <div class="y-label cc-side-head">
            <span>Everyone · ${() => cast().length}</span>
            <button class="y-btn y-btn-ghost cc-mini" title="Write a new character" onClick=${newCharacter}>
              +
            </button>
          </div>

          <${For} each=${cast}>
            ${(character: Character) => {
              const here = () => inOpenRoom(character.characterId);
              const onstage = () => !!live()[character.characterId];
              return html`
                <div
                  class="cc-card"
                  classList=${() => ({ live: here(), editing: editing() === character.characterId })}
                >
                  <div class="cc-card-head">
                    ${() => face(character, character.characterId)}
                    <span class="cc-name y-truncate">${character.name}</span>
                    <${Show} when=${here}>
                      <span class="y-badge y-badge-success cc-tag">${() =>
                        onstage() ? 'onstage' : 'in room'}</span>
                    </>
                  </div>
                  <div class="cc-card-actions">
                    <${Show}
                      when=${here}
                      fallback=${() => html`
                        <button
                          class="y-btn y-btn-ghost cc-mini"
                          onClick=${async () => {
                            const room = openRoomId();
                            if (!room) return;
                            await castInRoom(room, character.characterId);
                            await syncStage();
                          }}
                        >
                          Add to room
                        </button>
                      `}
                    >
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
                    </>
                    <button
                      class="y-btn y-btn-ghost cc-mini"
                      onClick=${() =>
                        setEditing(
                          editing() === character.characterId ? null : character.characterId,
                        )}
                    >
                      ${() => (editing() === character.characterId ? 'Close' : 'Edit')}
                    </button>
                  </div>
                  <${Show} when=${() => editing() === character.characterId}>
                    ${() => editor(character)}
                  </>
                </div>
              `;
            }}
          </>
        </div>
      </div>
    </aside>
  `;
}
