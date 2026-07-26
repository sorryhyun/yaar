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
 * `store.ts`; spawning with them is `main.ts`. That split is what lets the parsing be
 * tested without an iframe, and it is why the app's one genuinely fiddly regex lives in
 * a file with no I/O in it.
 */

// ── The documents ───────────────────────────────────────────────────────────

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

// ── consolidated_memory.md ──────────────────────────────────────────────────

export interface MemoryChunk {
  /** The `## [subtitle]` header, verbatim. What `recall` is called with. */
  subtitle: string;
  /** The chunk body with the present-day thought lifted out. */
  content: string;
  /** The `**Present thought:** "…"` line, when the chunk has one. */
  thought?: string;
}

/** `## [Anything_At_All]`. Unanchored at the end, as in the desktop app's parser. */
const SUBTITLE_RE = /^##\s*\[([^\]]+)\]/;

/**
 * The present-day thought line.
 *
 * `지금 드는 생각` is the desktop app's marker and stays canonical; the English aliases
 * are here because this port's own starter cast is written in English and a marker
 * nobody can read is a marker nobody writes. Curly quotes are accepted because a
 * document written in a word processor has them and the author will not know why their
 * thought vanished.
 */
const THOUGHT_RE =
  /\*\*\s*(?:지금 드는 생각|Present thought|Current thought)\s*:\*\*\s*["“']([^"”']*)["”']/;

function splitThought(body: string): { content: string; thought?: string } {
  const match = THOUGHT_RE.exec(body);
  if (!match) return { content: body.trim() };
  return {
    content: body
      .replace(match[0], '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    thought: match[1].trim() || undefined,
  };
}

/**
 * Split a memory document into independently retrievable chunks.
 *
 * Text before the first `## [subtitle]` is dropped — the convention's whole point is
 * that every chunk stands alone, so a preamble nothing can retrieve is a preamble that
 * would only ever be read by accident.
 */
export function parseConsolidatedMemory(markdown: string): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];
  let subtitle: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (subtitle === null) return;
    chunks.push({ subtitle, ...splitThought(body.join('\n')) });
  };

  for (const line of markdown.split('\n')) {
    const match = SUBTITLE_RE.exec(line);
    if (match) {
      flush();
      subtitle = match[1].trim();
      body = [];
    } else if (subtitle !== null) {
      body.push(line);
    }
  }
  flush();

  return chunks.filter((chunk) => !!chunk.subtitle);
}

/** One chunk by subtitle, or undefined. Case- and whitespace-insensitive on the way in. */
export function findMemory(chunks: MemoryChunk[], subtitle: string): MemoryChunk | undefined {
  const wanted = subtitle.trim().toLowerCase();
  return chunks.find((chunk) => chunk.subtitle.toLowerCase() === wanted);
}

// ── recent_events.md ────────────────────────────────────────────────────────

/**
 * How many rows of `recent_events.md` reach the prompt.
 *
 * The file keeps everything — it is the character's diary and pruning it is the user's
 * call — but only the tail is replayed. Unlike every other document here this one grows
 * without anybody deciding to grow it, and an unbounded section would eventually run
 * into the platform's 20k system-prompt ceiling mid-conversation, which would look like
 * the character suddenly failing to spawn for no reason the user can see.
 */
export const RECENT_EVENTS_PROMPT_ROWS = 40;

/** `YYYY-MM-DD` in local time — the date the row is stamped with. */
function isoDate(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/** The row one `memorize` call becomes. Single line: a row is a one-liner or it is prose. */
export function recentEventRow(entry: string, when: Date): string {
  return `- [${isoDate(when)}] ${entry.trim().replace(/\s*\n+\s*/g, ' ')}`;
}

/** Append one row, keeping the document a plain newline-separated list. */
export function appendRecentEvent(markdown: string, entry: string, when: Date): string {
  const row = recentEventRow(entry, when);
  const body = markdown.replace(/\s+$/, '');
  return body ? `${body}\n${row}\n` : `${row}\n`;
}

/** The tail of the diary, as the prompt sees it. */
function recentEventsTail(markdown: string): string {
  const rows = markdown
    .split('\n')
    .map((row) => row.trimEnd())
    .filter((row) => !!row.trim());
  return rows.slice(-RECENT_EVENTS_PROMPT_ROWS).join('\n');
}

// ── The system prompt ───────────────────────────────────────────────────────

/**
 * The frame every character is spawned inside.
 *
 * The documents are written in the third person — that is the convention's first rule,
 * because "Alice is brittle about her work" survives being read by a model that has to
 * *be* Alice, while "you are brittle about your work" reads as an instruction to perform
 * brittleness. Which means someone has to say "and you are her", and this is that
 * someone. It is app-owned rather than user-editable for the same reason the turn
 * instruction in `store.ts` is: it is scaffolding, and a user editing it is a user
 * debugging the app instead of writing a character.
 */
function preamble(name: string, hasMemories: boolean): string {
  const lines = [
    `You are ${name}. Everything below describes ${name} from the outside, in the third ` +
      `person; you answer from the inside, as ${name}, in the first person.`,
    '',
    `You are in a room with a person and, usually, other characters. You have just been ` +
      `handed what was said since your last turn. Answer as ${name} would — not as an ` +
      `assistant playing ${name}. Stay inside the room: never mention these notes, never ` +
      `describe your own behaviour from outside, never narrate stage directions.`,
  ];

  if (hasMemories) {
    lines.push(
      '',
      `${name} remembers more than is written here. When the moment turns on something ` +
        `from ${name}'s past — a promise, a person, an old injury — call the recall tool ` +
        `for that memory before answering, and let what you find colour the reply rather ` +
        `than being recited in it.`,
    );
  }

  lines.push(
    '',
    `When something happens in the room that ${name} would still be thinking about ` +
      `tomorrow, call the memorize tool with one line about it. That line is the only ` +
      `part of tonight ${name} will still have next time.`,
  );

  return lines.join('\n');
}

/**
 * Compose one character's system prompt from its documents.
 *
 * Sections and their headings mirror the desktop app's `config_to_markdown` so that a
 * persona folder produces the same character in either place. `consolidated_memory.md`
 * is conspicuously absent: it is the `recall` tool's index, and injecting it here would
 * pay for the entire backstory on every single turn — which is the cost the four-document
 * split exists to avoid.
 */
export function buildSystemPrompt(name: string, persona: Persona): string {
  const memories = parseConsolidatedMemory(persona.consolidatedMemory);
  const sections = [preamble(name, memories.length > 0)];

  const nutshell = persona.inANutshell.trim();
  if (nutshell) sections.push(`## ${name} in a nutshell\n\n${nutshell}`);

  const characteristics = persona.characteristics.trim();
  if (characteristics) sections.push(`## ${name}'s characteristics\n\n${characteristics}`);

  const recent = recentEventsTail(persona.recentEvents);
  if (recent) sections.push(`## Recent events\n\n${recent}`);

  return sections.join('\n\n');
}

// ── The character's tools ───────────────────────────────────────────────────

export interface CharacterToolParam {
  type: 'string';
  description?: string;
}

export interface CharacterTool {
  name: string;
  description: string;
  input?: Record<string, CharacterToolParam>;
}

/**
 * Characters the memory index may spend inside `recall`'s description.
 *
 * The platform caps a spawn's whole tool list at 6,000 characters, and a list that
 * overruns it fails the spawn rather than truncating — so a user who writes a
 * forty-chunk backstory would find their character simply unable to come onstage. The
 * index is elided instead, and `recall` names every subtitle in its not-found reply, so
 * an elided chunk is still reachable by a character that guesses at it.
 */
const MEMORY_INDEX_BUDGET = 2_400;

/**
 * Render the memory index: subtitle plus, where there is one, the present-day thought.
 *
 * The thought is the preview on purpose. `[Left_the_order]` tells a model nothing about
 * whether this turn is the turn to open it; `"I still check the door twice"` tells it
 * exactly that. It is the one line of the chunk written in the character's own voice.
 */
function memoryIndex(chunks: MemoryChunk[]): string {
  const rendered: string[] = [];
  let spent = 0;

  for (const [index, chunk] of chunks.entries()) {
    const entry = chunk.thought ? `[${chunk.subtitle}]: "${chunk.thought}"` : `[${chunk.subtitle}]`;
    if (spent + entry.length > MEMORY_INDEX_BUDGET && index > 0) {
      rendered.push(`…and ${chunks.length - index} more`);
      break;
    }
    rendered.push(entry);
    spent += entry.length + 2;
  }

  return rendered.join(', ');
}

/**
 * The tools one character is spawned with.
 *
 * Descriptions are written *to the character*, in the second person, because that is who
 * reads them — the operator-voice description of the same handler lives in the
 * `persona:*` command descriptors in `main.ts`. `recall` appears only when there is
 * something to recall, mirroring the desktop app's `include_tool` guard: a tool whose
 * index is empty is a tool that can only be called wrongly.
 */
export function characterTools(persona: Persona, name: string): CharacterTool[] {
  const tools: CharacterTool[] = [
    {
      name: 'skip',
      description:
        'Say nothing this turn. Call this when the others have covered it, when the ' +
        'question is not for you, or when staying quiet is what your character would do. ' +
        'Do not also write a reply — calling this IS your turn.',
    },
  ];

  const memories = parseConsolidatedMemory(persona.consolidatedMemory);
  if (memories.length > 0) {
    tools.push({
      name: 'recall',
      description:
        `Open one of ${name}'s memories in full, by subtitle. Use it when this moment ` +
        `turns on a past event, a relationship, or a promise and you need the details — ` +
        `and how ${name} feels about them now — to answer truthfully. Each entry below is ` +
        `a subtitle followed by the thought ${name} still carries from it.\n` +
        `Available memories: ${memoryIndex(memories)}`,
      input: {
        subtitle: {
          type: 'string',
          description: 'The subtitle of the memory to open, exactly as listed.',
        },
      },
    });
  }

  tools.push({
    name: 'memorize',
    description:
      'Record one line about something that just happened and that you would still be ' +
      'thinking about tomorrow — a promise made, a fight, something you learned about ' +
      'someone. One sentence, past tense, significant only. This is what you will still ' +
      'remember the next time this room opens; ordinary small talk is not worth a row.',
    input: {
      memory_entry: {
        type: 'string',
        description: 'The one-line memory, as you would tell it later.',
      },
    },
  });

  return tools;
}
