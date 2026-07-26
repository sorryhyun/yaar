/**
 * View fragments small enough to have no home of their own.
 *
 * `face` is here rather than in the sidebar because the transcript renders it too — the
 * same 24px avatar-or-emoji appears on a cast card and beside every line.
 */

import { Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { avatars, type Character } from '../store';

/** A character's avatar, falling back to its emoji when no image was uploaded. */
export const face = (character: Character | undefined, characterId: string) => html`
  <span class="cc-face">
    <${Show}
      when=${() => character && avatars()[character.characterId]}
      fallback=${() => html`<span class="cc-emoji">${() => character?.emoji ?? '🎭'}</span>`}
    >
      <img class="cc-avatar" src=${() => avatars()[characterId]} alt="" />
    </>
  </span>
`;
