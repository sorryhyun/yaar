/**
 * The two overlay sidebars' open/close state.
 *
 * Both are the shared `createCollapsiblePanel` machine, the same primitive slides-lite
 * drives its slide list and its edit panel with: expanded while the cursor is over the
 * panel (or its edge strip), a grace period before it folds back so a brief exit does
 * not flicker it shut, and a pin that persists so a user who wants a column can keep
 * one. Headless — the markup lives in `library.ts` and `participants.ts`.
 *
 * Module scope for the same reason `ui/state.ts` is: the app mounts once per document,
 * so the topbar button and the panel itself can both reach the same machine without
 * either owning it.
 */

import { createCollapsiblePanel } from '@bundled/yaar';

/** Grace period before a panel folds back after the cursor leaves it. */
export const CLOSE_DELAY_MS = 260;

const characters = createCollapsiblePanel({
  pinKey: 'characters-panel-pin.json',
  closeDelayMs: CLOSE_DELAY_MS,
  pinLabel: 'characters panel pin state',
});

const participants = createCollapsiblePanel({
  pinKey: 'participants-panel-pin.json',
  closeDelayMs: CLOSE_DELAY_MS,
  pinLabel: 'participants panel pin state',
});

/** Left sidebar — the character library, plus the room list. */
export const charactersExpanded = characters.expanded;
export const charactersPinned = characters.pinned;
export const openCharacters = characters.open;
export const scheduleCharactersClose = characters.scheduleClose;
export const cancelCharactersClose = characters.cancelClose;
export const toggleCharactersPin = characters.togglePin;

/** Right sidebar — who is in the room right now. */
export const participantsExpanded = participants.expanded;
export const participantsPinned = participants.pinned;
export const openParticipants = participants.open;
export const scheduleParticipantsClose = participants.scheduleClose;
export const cancelParticipantsClose = participants.cancelClose;
export const toggleParticipantsPin = participants.togglePin;
