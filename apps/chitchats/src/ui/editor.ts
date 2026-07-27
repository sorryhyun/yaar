/**
 * The character editor — the panel that opens inside a cast card.
 *
 * Four documents behind a tab strip, plus the row-level fields (name, emoji, priority,
 * avatar) that live on the character row rather than in its persona folder.
 */

import { For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { showConfirm } from '@bundled/yaar';

import {
  avatars,
  personaOf,
  writePersona,
  updateCharacter,
  removeCharacter,
  type Character,
} from '../store';
import { PERSONA_DOCS, type Persona, type PersonaDoc, type PersonaKey } from '../persona';
import { dispose } from '../agents';
import { editingDoc, setEditingDoc, setEditing } from './state';
import { onAvatarPicked, onAvatarFromStorage, onAvatarRemoved } from '../stage';

/** A one-document patch, built so the key stays typed rather than widening to string. */
function onePatch(key: PersonaKey, body: string): Partial<Persona> {
  const patch: Partial<Persona> = {};
  patch[key] = body;
  return patch;
}

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

/**
 * The picture, and the three ways to change it.
 *
 * The slot is itself the file picker — clicking a face to replace it is the gesture
 * every other app has taught — and the buttons beside it are the two things a click on
 * the slot cannot express. `Remove` only exists while there is something to remove, so
 * the row is two buttons wide on a character that has never had a picture, which is
 * what keeps it inside a 280px sidebar.
 */
const avatarBlock = (character: Character) => {
  const src = () => avatars()[character.characterId];

  return html`
    <div class="cc-avatar-row">
      <label class="cc-avatar-slot" title="Choose a picture">
        <${Show}
          when=${src}
          fallback=${() => html`<span class="cc-slot-emoji">${() => character.emoji}</span>`}
        >
          <img class="cc-slot-img" src=${src} alt="" />
        </>
        <input
          type="file"
          accept="image/*"
          onChange=${(e: Event) => onAvatarPicked(character.characterId, e)}
        />
      </label>

      <div class="cc-avatar-side">
        <div class="cc-avatar-actions">
          <label class="y-btn y-btn-ghost cc-mini cc-upload">
            Upload
            <input
              type="file"
              accept="image/*"
              onChange=${(e: Event) => onAvatarPicked(character.characterId, e)}
            />
          </label>
          <button
            class="y-btn y-btn-ghost cc-mini"
            title="Use an image already in storage, such as one Anima generated"
            onClick=${() => onAvatarFromStorage(character.characterId)}
          >
            From storage
          </button>
          <${Show} when=${src}>
            <button
              class="y-btn y-btn-ghost cc-mini"
              title="Go back to the emoji"
              onClick=${() => onAvatarRemoved(character.characterId)}
            >
              Remove
            </button>
          </>
        </div>
        <div class="cc-editor-note">
          Cropped square to 256×256. Without a picture, the emoji is the face.
        </div>
      </div>
    </div>
  `;
};

export const editor = (character: Character) => html`
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
    </div>

    ${() => avatarBlock(character)}

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
