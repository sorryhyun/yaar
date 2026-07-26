/**
 * The strip above the transcript: the two sidebar handles, and the open room's name.
 *
 * Each button both peeks and pins its panel — hovering it reveals the panel the same way
 * the screen-edge strip does, and clicking it pins the panel open until clicked again.
 * The hover half is what makes the buttons discoverable as the same control as the edge;
 * the click half is what lets somebody who wants a permanent column have one.
 *
 * The room name renames in place: click it and it becomes an input. There is no rename
 * button anywhere, here or in the room list — the name *is* the control, which is also
 * why the collapsed state is a borderless button rather than a span: it has to be
 * focusable and reachable by keyboard to be the only way in.
 */

import { Show, createSignal } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';

import { openRoom, renameRoom } from '../store';
import { max } from './state';
import {
  charactersPinned,
  openCharacters,
  scheduleCharactersClose,
  toggleCharactersPin,
  participantsPinned,
  openParticipants,
  scheduleParticipantsClose,
  toggleParticipantsPin,
} from './panels';

export interface TopbarContext {
  onstageCount: () => number;
}

export function topbar(ctx: TopbarContext) {
  /** Whether the title is currently an input rather than a label. */
  const [renaming, setRenaming] = createSignal(false);

  /**
   * Take what is in the box, unless it is blank or unchanged.
   *
   * Leaves `renaming` false before it writes, so the blur that follows an Enter cannot
   * arrive with the field still open and save the same name twice.
   */
  const commit = (el: HTMLInputElement) => {
    const room = openRoom();
    const name = el.value.trim();
    setRenaming(false);
    if (room && name && name !== room.name) void renameRoom(room.roomId, name);
  };

  return html`
    <header class="cc-topbar">
      <button
        class="y-btn y-btn-ghost cc-handle"
        classList=${() => ({ active: charactersPinned() })}
        title="The character library — hover to peek, click to keep it open"
        onMouseEnter=${openCharacters}
        onMouseLeave=${scheduleCharactersClose}
        onClick=${() => toggleCharactersPin()}
      >
        🎭 Characters
      </button>

      <div class="cc-room-title">
        <${Show} when=${openRoom}>
          <span class="cc-emoji">${() => openRoom()?.emoji}</span>
          <${Show}
            when=${renaming}
            fallback=${() => html`
              <button
                class="cc-title-text y-truncate"
                title="Click to rename this room"
                onClick=${() => setRenaming(true)}
              >
                ${() => openRoom()?.name}
              </button>
            `}
          >
            <input
              class="y-input cc-title-input"
              value=${() => openRoom()?.name ?? ''}
              ref=${(el: HTMLInputElement) =>
                queueMicrotask(() => {
                  el.focus();
                  el.select();
                })}
              onKeyDown=${(e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit(e.target as HTMLInputElement);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  // Straight out, without committing — and the guard in the blur
                  // handler is what keeps the unmount from saving it anyway.
                  setRenaming(false);
                }
              }}
              onFocusOut=${(e: FocusEvent) => {
                // focusout, not blur: blur does not bubble, and this runtime's html
                // templates only wire up the events Solid delegates.
                if (renaming()) commit(e.target as HTMLInputElement);
              }}
            />
          </>
        </>
      </div>

      <button
        class="y-btn y-btn-ghost cc-handle"
        classList=${() => ({ active: participantsPinned() })}
        title="Who is in the room — hover to peek, click to keep it open"
        onMouseEnter=${openParticipants}
        onMouseLeave=${scheduleParticipantsClose}
        onClick=${() => toggleParticipantsPin()}
      >
        In the room · ${() => ctx.onstageCount()}/${() => max()}
      </button>
    </header>
  `;
}
