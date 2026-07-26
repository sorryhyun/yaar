/**
 * The tools one character is spawned with, derived from its own documents.
 *
 * Descriptions here are written *to the character*, in the second person, because that
 * is who reads them — the operator-voice description of the same handler lives in the
 * `persona:*` command descriptors in `protocol.ts`.
 */

import type { Persona } from './documents';
import { parseConsolidatedMemory, type MemoryChunk } from './memory';

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
 * `persona:*` command descriptors in `protocol.ts`. `recall` appears only when there is
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
