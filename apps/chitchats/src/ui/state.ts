/**
 * View state — the signals the UI owns, as opposed to the ones the data owns.
 *
 * These lived inside `App()` until the component was split across files. They are at
 * module scope now for the same reason `store.ts` and `tape.ts` keep theirs there: the
 * app mounts exactly once per document, so a signal declared here has precisely the
 * lifetime it had as a component local, and the sidebar and the room can both read it
 * without either owning it.
 *
 * Nothing derived lives here on purpose. A `createMemo` at module scope is created
 * outside a reactive root, so the two memos this app has stay in `App()`, where they
 * have an owner, and are handed to the fragments that need them.
 */

import { createSignal } from '@bundled/solid-js';
import type { PersonaKey } from '../persona';

/** The compose box's text. */
export const [draft, setDraft] = createSignal('');

/** How many characters may be onstage at once — the platform's cap, read at boot. */
export const [max, setMax] = createSignal(4);

/** The characterId whose editor is open, or null. */
export const [editing, setEditing] = createSignal<string | null>(null);

/** Which of the four persona documents the open editor is showing. */
export const [editingDoc, setEditingDoc] = createSignal<PersonaKey>('inANutshell');

/** Whether the "add someone to the room" list is expanded. */
export const [showCastPicker, setShowCastPicker] = createSignal(false);

/** True until the first load settles — suppresses the empty state during boot. */
export const [booting, setBooting] = createSignal(true);
