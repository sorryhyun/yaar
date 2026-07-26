/**
 * The left column: the room list, and the cast of the open room.
 *
 * Returns the whole `<aside>`, which is one of the two grid children of `.cc-root`.
 *
 * The two derived values it needs are passed in rather than imported. They are memos,
 * and a memo has to be created under a reactive owner — so they stay in `App()` and
 * arrive here as plain accessor functions.
 */

import { For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { showConfirm } from '@bundled/yaar';

import {
  rooms,
  openRoomId,
  roomCast,
  renameRoom,
  removeRoom,
  castInRoom,
  uncastFromRoom,
  type Character,
  type Room,
} from '../store';
import { speaker } from '../tape';
import { live, dispose } from '../agents';
import { editing, setEditing, max, showCastPicker, setShowCastPicker } from './state';
import { face } from './views';
import { editor } from './editor';
import { switchRoom, newRoom, newCharacter, syncStage } from '../stage';

export interface SidebarContext {
  onstageCount: () => number;
  offstageCast: () => Character[];
}

export function sidebar(ctx: SidebarContext) {
  return html`
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
          <span>In the room · ${() => ctx.onstageCount()}/${() => max()}</span>
          <button
            class="y-btn y-btn-ghost cc-mini"
            onClick=${() => setShowCastPicker(!showCastPicker())}
          >
            +
          </button>
        </div>

        <${Show} when=${showCastPicker}>
          <div class="cc-picker">
            <${For} each=${ctx.offstageCast}>
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
  `;
}
