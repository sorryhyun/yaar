/**
 * Prompt composition — a profile's system prompt is an ordered list of parts.
 *
 * A part is a markdown file imported as text (see `src/md.d.ts`): shared ones live in
 * `profiles/prompts/`, profile-specific ones in `profiles/{profile}/prompts/`. The
 * profile's import list *is* its declaration of which parts it uses and in what order —
 * there is no registry to keep in sync.
 *
 * Parts are trimmed and joined with a blank line, so a part file owns its own heading
 * and never its surrounding whitespace. An empty part vanishes rather than emitting a
 * stray separator.
 */
export function composePrompt(...parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
}
