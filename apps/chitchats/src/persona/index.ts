/**
 * The persona format — what a character *is* on disk, and the prompt built from it.
 *
 * Ported from the ChitChats desktop app (`../chitchats-public`, `agents/README.md`),
 * whose save format is a folder of four markdown documents per character. The split is
 * not filing for its own sake; each document is read at a different moment, and that is
 * the whole reason there are four rather than one:
 *
 *   in_a_nutshell.md        who they are in 1–3 sentences  → system prompt, every turn
 *   characteristics.md      timeless traits and appearance → system prompt, every turn
 *   consolidated_memory.md  standalone `## [subtitle]` chunks → NOT in the prompt; the
 *                           character pulls one with `recall` when it needs the details
 *   recent_events.md        one-liners the character wrote itself with `memorize`
 *                           → system prompt (tail only), every turn
 *
 * The memory file is the load-bearing idea. A backstory long enough to be worth having
 * is too long to replay on every turn, so it is indexed rather than injected: the
 * subtitles (and each chunk's present-day thought, which is what makes a subtitle worth
 * opening) ride in the `recall` tool's description, and the body arrives only when the
 * character asks for it. `recent_events.md` is the mirror image — small, growing, and
 * always present, because a character that cannot remember last night's conversation is
 * a character the user has to reintroduce every session.
 *
 * Everything here is pure: text in, text out. Reading and writing the documents is
 * `store.ts`; spawning with them is `stage.ts`. That split is what lets the parsing be
 * tested without an iframe, and it is why the app's one genuinely fiddly regex lives in
 * a file with no I/O in it.
 *
 * This file is a barrel over four modules — `documents`, `memory`, `prompt`, `tools`.
 * It re-exports exactly what the single-file version exported, no more: helpers that
 * were module-private before the split (the tail cutter, the index renderer) stay
 * private to their module and are reachable only by their one caller.
 */

export {
  PERSONA_DOCS,
  EMPTY_PERSONA,
  personaFrom,
  personaDir,
  hasIdentity,
  type Persona,
  type PersonaKey,
  type PersonaDoc,
} from './documents';

export {
  parseConsolidatedMemory,
  findMemory,
  recentEventRow,
  appendRecentEvent,
  RECENT_EVENTS_PROMPT_ROWS,
  type MemoryChunk,
} from './memory';

export { buildSystemPrompt } from './prompt';

export { characterTools, type CharacterTool, type CharacterToolParam } from './tools';
