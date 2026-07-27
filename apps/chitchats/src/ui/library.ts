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
  personaOf,
  removeRoom,
  castInRoom,
  uncastFromRoom,
  type Character,
  type Room,
} from '../store';
import { live, dispose } from '../agents';
import {
  editing,
  setEditing,
  libraryView,
  setLibraryView,
  libraryFilter,
  setLibraryFilter,
} from './state';
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
const inOpenRoom = (characterId: string) => (openRoom()?.characterIds ?? []).includes(characterId);

/** What is currently typed in the filter box, folded for comparison. */
const needle = () => libraryFilter().trim().toLowerCase();

/** Case-insensitive substring match across whatever a row can cheaply be found by. */
const matches = (...fields: (string | undefined)[]) => {
  const query = needle();
  if (!query) return true;
  return fields.some((field) => (field ?? '').toLowerCase().includes(query));
};

/**
 * The two filtered lists.
 *
 * Plain accessors rather than memos: they are read inside `For`, which is already a
 * tracking scope, and a `createMemo` at module scope has no reactive owner. A character
 * is findable by its emoji and by its nutshell as well as its name — both are already
 * in memory (the row and the persona cache), so neither costs a read.
 */
const shownRooms = () => rooms().filter((room) => matches(room.name, room.emoji));
const shownCast = () =>
  cast().filter((character) =>
    matches(character.name, character.emoji, personaOf(character.characterId).inANutshell),
  );

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

        <div class="cc-search">
          <input
            class="y-input cc-search-input"
            type="text"
            placeholder="Filter rooms and characters…"
            aria-label="Filter rooms and characters"
            value=${libraryFilter}
            onInput=${(e: Event) => setLibraryFilter((e.target as HTMLInputElement).value)}
          />
          <${Show} when=${() => libraryFilter() !== ''}>
            <button
              class="cc-search-clear"
              title="Clear the filter"
              aria-label="Clear the filter"
              onClick=${() => setLibraryFilter('')}
            >
              ✕
            </button>
          </>
        </div>

        <div class="cc-panel-rooms">
          <div class="y-label cc-side-head">
            <span>Rooms</span>
            <button class="y-btn y-btn-ghost cc-mini" onClick=${newRoom}>+</button>
          </div>
          <${For} each=${shownRooms}>
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

          <${Show} when=${() => needle() !== '' && shownRooms().length === 0}>
            <div class="cc-hint cc-no-match">No rooms match that.</div>
          </>
        </div>

        <div class="cc-panel-library">
          <div class="y-label cc-side-head">
            <span>Everyone · ${() => shownCast().length}</span>
            <button class="y-btn y-btn-ghost cc-mini" title="Write a new character" onClick=${newCharacter}>
              +
            </button>
          </div>

          <${For} each=${shownCast}>
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

          <${Show} when=${() => needle() !== '' && shownCast().length === 0}>
            <div class="cc-hint cc-no-match">No characters match that.</div>
          </>
        </div>
      </div>
    </aside>
  `;
}
