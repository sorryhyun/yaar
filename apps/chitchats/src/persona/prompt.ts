/**
 * The system prompt one character is spawned inside.
 *
 * Sections and their headings mirror the desktop app's `config_to_markdown` so that a
 * persona folder produces the same character in either place.
 */

import type { Persona } from './documents';
import { parseConsolidatedMemory, recentEventsTail } from './memory';

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
