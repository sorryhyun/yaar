/**
 * How a describe index line summarizes one export — shared by the `.d.ts` slicer
 * (`describe-library.ts`) and the npm-package reader (`describe-upstream.ts`), so an
 * export reads the same whichever of them found it.
 */

/** An index line's summary past this is cut. */
export const SUMMARY_MAX_CHARS = 180;
/** An undocumented upstream export's collapsed signature past this is cut. */
export const SIGNATURE_MAX_CHARS = 120;

/** Listed as `types:` in an index rather than with a summary each. */
export const TYPE_KINDS: ReadonlySet<string> = new Set(['type', 'interface', 'enum']);

/** `text`, cut to `max` characters with an ellipsis when longer. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}…` : text;
}

/**
 * The first sentence of a doc comment's first paragraph, whitespace collapsed — or the
 * whole paragraph when no sentence ends in it, `''` when it is empty. Not clipped.
 */
export function firstSentence(doc: string): string {
  const prose = doc
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ')
    .trim();
  return /^(.+?[.!?])(\s|$)/.exec(prose)?.[1] ?? prose;
}

/** A declaration without its leading `export` / `export declare`. */
export function withoutExportKeyword(declaration: string): string {
  return declaration.replace(/^export (declare )?/, '');
}

/** `- label: \`a\`, \`b\`` — a name list in an index. */
export function nameList(label: string, names: string[]): string {
  return `- ${label}: ${names.map((n) => `\`${n}\``).join(', ')}`;
}
