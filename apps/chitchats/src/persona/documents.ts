/**
 * The four documents — what a character *is* on disk.
 *
 * `PERSONA_DOCS` is the single list that drives storage filenames, the editor's tabs and
 * the prompt's section order, so a fifth document would be one entry here rather than
 * four edits spread across the app.
 */

export interface Persona {
  /** 1–3 sentences, third person. Role, the one defining trait, current situation. */
  inANutshell: string;
  /** `## Appearance` then `## Personality`, as bullets. Traits that do not change. */
  characteristics: string;
  /** `## [subtitle]` chunks, each standalone. Reached by `recall`, never injected. */
  consolidatedMemory: string;
  /** `- [YYYY-MM-DD] one-liner` rows, appended by the character's own `memorize`. */
  recentEvents: string;
}

export type PersonaKey = keyof Persona;

export interface PersonaDoc {
  key: PersonaKey;
  /** Filename under `characters/{characterId}/` — the convention's own names. */
  file: string;
  /** Tab label in the editor. */
  label: string;
  /** What belongs in this document, shown under the editor. */
  hint: string;
}

/**
 * The four documents, in the order they are written and shown.
 *
 * One list drives storage, the editor's tabs, and the prompt's section order, so a fifth
 * document is one entry rather than four edits.
 */
export const PERSONA_DOCS: readonly PersonaDoc[] = [
  {
    key: 'inANutshell',
    file: 'in_a_nutshell.md',
    label: 'Nutshell',
    hint:
      'One to three sentences, third person: their role, their most defining trait, and ' +
      'where they stand right now. No backstory — that is what Memory is for.',
  },
  {
    key: 'characteristics',
    file: 'characteristics.md',
    label: 'Traits',
    hint:
      '## Appearance, then ## Personality, as bullets. Only what never changes — speech ' +
      'habits, values, weaknesses. No events, no moods.',
  },
  {
    key: 'consolidatedMemory',
    file: 'consolidated_memory.md',
    label: 'Memory',
    hint:
      '## [subtitle] chunks, each readable on its own, each ending with **Present ' +
      'thought:** "…". Not in the prompt — the character opens one with its recall tool.',
  },
  {
    key: 'recentEvents',
    file: 'recent_events.md',
    label: 'Recent',
    hint:
      'Written by the character itself, one line per turn it chose to remember. Edit only ' +
      'to prune. The tail of this is in every prompt.',
  },
];

export const EMPTY_PERSONA: Persona = {
  inANutshell: '',
  characteristics: '',
  consolidatedMemory: '',
  recentEvents: '',
};

/** Fill in the documents a caller left out. */
export function personaFrom(partial: Partial<Persona> | undefined): Persona {
  return { ...EMPTY_PERSONA, ...(partial ?? {}) };
}

/** Where one character's documents live in app storage. */
export function personaDir(characterId: string): string {
  return `characters/${characterId}`;
}

/**
 * Enough of a persona to spawn on.
 *
 * Nutshell *or* traits: a character with only a memory file has a past and no present,
 * and would answer as a blank assistant that happens to remember things.
 */
export function hasIdentity(persona: Persona): boolean {
  return !!(persona.inANutshell.trim() || persona.characteristics.trim());
}
