export {};

interface Location {
  file: string;
  line: number;
  column: number;
}

/** The span a hover sits on: one identifier, `length` characters wide, starting at `column`. */
export interface HoveredSpan extends Location {
  length: number;
}

export interface OtherReferences<R> {
  /** Usages only: neither the hovered occurrence nor any declaration line. */
  references: R[];
  /** Total project usages by the same rule, counting those past the result cap. */
  total: number;
  /** Distinct files among `references`; the server's own count when the list was clipped. */
  files: number;
  /** Where the symbol is declared — null when the server named no declaration. */
  definition: Location | null;
  /** The hovered occurrence is the declaration, so `definition` would point at itself. */
  declaredHere: boolean;
}

/**
 * What a hover card lists for an identifier: its usages, minus the occurrence under the
 * pointer, with the declaration split out as a separate jump target. A declaration is matched
 * by line rather than column, because the server flags `isDefinition` only on some hits and a
 * `definitions` entry need not start on the same column as the reference it duplicates.
 */
export function otherReferences<R extends Location & { isDefinition?: true }>(
  result: {
    references?: R[];
    definitions?: Location[];
    totalReferences?: number;
    files?: number;
    truncated?: true;
  },
  hovered: HoveredSpan,
): OtherReferences<R> {
  const all = result.references ?? [];
  const definitions = result.definitions ?? [];
  const onHovered = (loc: Location) =>
    loc.file === hovered.file &&
    loc.line === hovered.line &&
    loc.column >= hovered.column &&
    loc.column < hovered.column + hovered.length;
  const onDefinitionLine = (r: R) =>
    r.isDefinition === true || definitions.some((d) => d.file === r.file && d.line === r.line);
  const references = all.filter((r) => !onHovered(r) && !onDefinitionLine(r));
  const removed = all.length - references.length;
  const total = Math.max(0, (result.totalReferences ?? all.length) - removed);
  const files = result.truncated
    ? (result.files ?? 0)
    : new Set(references.map((r) => r.file)).size;
  const declaredHere =
    definitions.some(onHovered) || all.some((r) => r.isDefinition === true && onHovered(r));
  const def = definitions[0] ?? all.find((r) => r.isDefinition === true);
  const definition = def ? { file: def.file, line: def.line, column: def.column } : null;
  return { references, total, files, definition, declaredHere };
}

export interface CallerHit {
  caller: string;
  kind: string;
  file: string;
  line: number;
  calls: { line: number; column: number }[];
}

/** How a caller reads when the call hierarchy could only say which module it is in. */
export const TOP_LEVEL_CALLER = '(top level)';

/**
 * Name the callers the call hierarchy files under the module. An arrow function in an object
 * literal is anonymous to it, so a command handler reads as `(top level)` at line 1, while the
 * same call's reference knows its `enclosing` property path (`fileCommands.files/grep.run`).
 * Each call moves to that name; a call really at module scope, or one whose reference a
 * `maxResults` cap clipped, stays where it was.
 */
export function attributeCallers(
  callers: CallerHit[],
  references: { file: string; line: number; column: number; enclosing: string | null }[],
): CallerHit[] {
  const out: CallerHit[] = [];
  for (const hit of callers) {
    if (hit.caller !== TOP_LEVEL_CALLER) {
      out.push(hit);
      continue;
    }
    const named = new Map<string, CallerHit>();
    const unnamed: CallerHit['calls'] = [];
    for (const call of hit.calls) {
      const onLine = references.filter((r) => r.file === hit.file && r.line === call.line);
      const ref = onLine.find((r) => r.column === call.column) ?? onLine[0];
      if (!ref?.enclosing) {
        unnamed.push(call);
        continue;
      }
      const row = named.get(ref.enclosing);
      if (row) row.calls.push(call);
      else
        named.set(ref.enclosing, {
          caller: ref.enclosing,
          kind: 'property',
          file: hit.file,
          line: call.line,
          calls: [call],
        });
    }
    out.push(...named.values());
    if (unnamed.length > 0) out.push({ ...hit, calls: unnamed });
  }
  return out;
}

export function otherReferencesSummary(total: number, files: number, declaredHere = false): string {
  if (total === 0) return declaredHere ? 'No references' : 'No other references';
  const where = `in ${files} file${files === 1 ? '' : 's'}`;
  return `${total} ${declaredHere ? '' : 'other '}reference${total === 1 ? '' : 's'} ${where}`;
}
