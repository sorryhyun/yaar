/**
 * `VerbResult` — what every verb returns — and the pure builders that make one.
 *
 * A leaf on purpose: it imports nothing from `handlers/`, `session/` or `agents/`, so the
 * registry that defines the verb layer, the handlers above it and the `features/` below
 * them can all build results without reaching for the session hub. Beside `getActiveSession`
 * (where the builders used to sit) the registry could not import them without a cycle, and
 * every feature had to import upward from `handlers/` to say `ok`.
 */

export interface EmbeddedResourceBlock {
  type: 'resource';
  resource:
    | { uri: string; text: string; mimeType?: string }
    | { uri: string; blob: string; mimeType?: string };
}

export interface ResourceLinkBlock {
  type: 'resource_link';
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  /** Optional resource-specific hint (e.g. app `kind: 'system' | 'app'`). */
  kind?: string;
}

/** One block of a `VerbResult`'s content — the canonical MCP content-block union. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | EmbeddedResourceBlock
  | ResourceLinkBlock;

/** Check if a value is an array of MCP content blocks. */
export function isContentBlocks(value: unknown): value is ContentBlock[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (item) =>
      item &&
      typeof item === 'object' &&
      (((item as Record<string, unknown>).type === 'text' &&
        typeof (item as Record<string, unknown>).text === 'string') ||
        ((item as Record<string, unknown>).type === 'image' &&
          typeof (item as Record<string, unknown>).data === 'string') ||
        ((item as Record<string, unknown>).type === 'resource' &&
          typeof (item as Record<string, unknown>).resource === 'object') ||
        ((item as Record<string, unknown>).type === 'resource_link' &&
          typeof (item as Record<string, unknown>).uri === 'string')),
  );
}

export interface VerbResult {
  content: ContentBlock[];
  isError?: boolean;
  /**
   * This failure is "the resource is not there", not "the call went wrong". Absence is
   * a routine answer — an app reading an optional config file on a first run — so the
   * doors that count failures can leave it out of the tally instead of reporting a
   * clean first launch as dozens of errors. Set only alongside `isError: true`; see
   * {@link notFoundError}.
   */
  notFound?: boolean;
  /** An `okLinks([])` result — a listing with no children. See {@link isEmptyLinkList}. */
  emptyList?: boolean;
  /**
   * The read's `lines`/`pattern` filter was applied to this result. A read that asked for
   * one and comes back without this flag had it ignored, and `ResourceRegistry.execute`
   * says so — see `hasLineFilter` in lib/read-options.ts. Stripped there; never leaves the
   * registry.
   */
  readFiltered?: boolean;
  /**
   * Notes `prependNote` added to a result carrying `structuredContent`, newest first. Their
   * text blocks never reach a model beside that object, so `foldNotes` moves them into it at
   * the MCP boundary. Never set without `structuredContent`.
   */
  notes?: string[];
  /**
   * Optional lossless, typed copy of the result, for `POST /api/verb` (app→app SDK calls)
   * and `resolveAppWindow`. Rides through to the MCP `CallToolResult` via the tool
   * handler's `{...result}` spread — and there it **replaces the text blocks for the
   * model**: the Claude CLI and Codex both hand the model the serialized
   * `structuredContent` and drop every text block beside it (the CLI keeps non-text blocks).
   * Anything a model must read, a note or truncation included, belongs inside this object
   * when it is set. See {@link okJson}.
   *
   * Object-only, matching the MCP `structuredContent` contract (and the SDK's
   * `{[x:string]:unknown}` type). Bare-array returns keep their text-only shape and
   * still round-trip through `toEnvelope`'s `tryParseJson`.
   */
  structuredContent?: Record<string, unknown>;
}

/**
 * Prepend a note to a VerbResult, as a `(…)` text block.
 *
 * On a result carrying `structuredContent` the text block never reaches a model (see
 * {@link okJson}), so the note is also recorded in `notes` for {@link foldNotes} to carry
 * into the object at the MCP boundary. It is not folded here: this result may be headed
 * for `POST /api/verb`, whose `data` is the app's own object and must not grow our keys.
 */
export function prependNote(result: VerbResult, note: string): VerbResult {
  return {
    ...result,
    content: [{ type: 'text', text: `(${note})` }, ...result.content],
    ...(result.structuredContent ? { notes: [note, ...(result.notes ?? [])] } : {}),
  };
}

/**
 * Carry a result's `notes` into its `structuredContent` as `_notes`, first, where a model
 * reads them. Call once, where a result leaves for a model — the MCP tool boundary — and
 * never on a path to `POST /api/verb`.
 */
export function foldNotes(result: VerbResult): VerbResult {
  const { notes, ...rest } = result;
  if (!notes?.length || !rest.structuredContent) return rest;
  const { _notes: earlier, ...data } = rest.structuredContent;
  return {
    ...rest,
    structuredContent: { _notes: [...notes, ...(Array.isArray(earlier) ? earlier : [])], ...data },
  };
}

/** Create a successful text result */
export const ok = (text: string) => ({
  content: [{ type: 'text' as const, text }],
});

/**
 * Above this many bytes of compact JSON, `okJson` stops indenting.
 *
 * Indentation is readability the model pays for by the byte, and the two sides of that
 * trade invert with size. A small result is easier to read nested; a large one is mostly
 * whitespace. `describe('yaar://apps/studio-3d')` measured 43 KB of compact protocol that
 * `JSON.stringify(data, null, 2)` inflated to 69 KB — 26 KB of leading spaces, 38% of the
 * block, on the one channel that is charged to the context window. Nothing at that size is
 * being read by a human, and no model needs a 2-space gutter to find `"commands"`.
 *
 * 8 KB, because that is comfortably above every routine result (a window list, a config
 * read, a storage stat) and comfortably below the ones where the gutter is the payload.
 * It is a display choice only: `structuredContent` is unaffected, so every programmatic
 * reader sees exactly the same bytes either way. Since a model reads `structuredContent`
 * whenever there is one (see `okJson`), the gutter only reaches a model for a bare array —
 * which is why {@link jsonText} never indents one, whatever its size.
 */
const COMPACT_JSON_THRESHOLD = 8_192;

/**
 * The text block of a JSON result: indented below {@link COMPACT_JSON_THRESHOLD}, compact
 * above it, and compact at any size for a bare array.
 *
 * The array is the exception because it is the one shape whose text *is* what the model
 * reads: `structuredContent` is object-only, so nothing stands in for it. An object's
 * indented text reaches the session log and nothing else; an array's reaches the context
 * window, where a 25-slide deck state measured 1.8 KB compact and twice that indented.
 */
export function jsonText(data: object): string {
  const compact = JSON.stringify(data);
  return Array.isArray(data) || compact.length > COMPACT_JSON_THRESHOLD
    ? compact
    : JSON.stringify(data, null, 2);
}

/**
 * Create a successful JSON result. Only accepts objects/arrays — use ok() for plain text.
 *
 * Text per {@link jsonText}: indented below {@link COMPACT_JSON_THRESHOLD}, compact above
 * it and for a bare array.
 *
 * **When `structuredContent` is present it is what the model reads, not the text.** Both
 * clients prefer it: the Claude CLI sends `JSON.stringify(structuredContent)` in place of
 * every text block (keeping only non-text blocks, rendered, ahead of it), and Codex sends the
 * serialized `structuredContent` alone. So a text block next to it — the indented copy
 * here, a `prependNote`, the `[layout]` context — never reaches a model. Put anything a
 * model must see *inside* the object: `prependNote` records its note for `foldNotes` to
 * carry in as `_notes`, and the verb tools add `_layout`. (`providers/codex/message-mapper.ts` reading
 * `content` first is YAAR's own activity display, not the model's view.)
 *
 * The text block is still what `toEnvelope`'s fallback and the session log read, and what
 * a client that ignores `structuredContent` would show. `POST /api/verb` and
 * `resolveAppWindow` read `structuredContent`. It is object-only per the MCP contract, so a
 * bare array is left text-only — same trade-off `wrapAppValue` makes — and still
 * round-trips through `toEnvelope`'s tryParseJson.
 */
export const okJson = (data: object) => ({
  content: [{ type: 'text' as const, text: jsonText(data) }],
  ...(Array.isArray(data) ? {} : { structuredContent: data as Record<string, unknown> }),
});

/** Create an error text result (sets isError: true) */
export const error = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  isError: true,
});

/**
 * An error that says "there is nothing at this URI", tagged as such.
 *
 * Still an error — the caller asked for something and did not get it — but flagged so
 * the doors that count failures can tell a missing optional file apart from a call that
 * went wrong. Every `File not found` an app produced by reading a config file it does
 * not have yet used to land in the session's failure tally; on a first run that was the
 * overwhelming majority of it. See `VerbResult.notFound`.
 */
export const notFoundError = (text: string): VerbResult => ({
  content: [{ type: 'text' as const, text }],
  isError: true,
  notFound: true,
});

/**
 * The answer to a `read` whose caller passed `missingOk` and whose resource is absent.
 *
 * Deliberately the same shape as reading a file that holds `null`: the option exists so
 * a caller with a fallback stops manufacturing failures, not so it can audit presence.
 * See `ReadOptions.missingOk`.
 */
export const okMissing = (): VerbResult => ({
  content: [{ type: 'text' as const, text: 'null' }],
});

/** Create a result with text and images */
export const okWithImages = (text: string, images: Array<{ data: string; mimeType: string }>) => ({
  content: [
    { type: 'text' as const, text },
    ...images.map((img) => ({
      type: 'image' as const,
      data: img.data,
      mimeType: img.mimeType,
    })),
  ],
});

/** Create a successful result with an embedded resource block. */
export const okResource = (uri: string, text: string, mimeType: string): VerbResult => ({
  content: [{ type: 'resource', resource: { uri, text, mimeType } }],
});

/** Create a successful result with an embedded JSON resource block. */
export const okJsonResource = (uri: string, data: object): VerbResult =>
  okResource(uri, JSON.stringify(data, null, 2), 'application/json');

/** Text block a list result carries when it has no children. See `okLinks`. */
const EMPTY_LIST_TEXT = '(empty)';

/**
 * Create a successful result with resource_link blocks for navigable lists.
 *
 * Deliberately **no** `structuredContent`. Both model clients let it win over `content`
 * (see `okJson`), so a `{ items }` mirror of the links was what the model read: the Claude
 * CLI renders the resource_link blocks as text *and* appends the JSON, delivering every
 * listing twice (a 70-row window list measured 34.6 KB, 19 KB of it the copy), and both
 * clients drop the text blocks — so every `prependNote` on a listing never reached a model.
 * Without it, Codex serializes the blocks themselves, extra fields (`size`, `modifiedAt`)
 * included, and the CLI renders them once. `toEnvelope` (routes/verb.ts) reads the blocks.
 */
export const okLinks = (
  links: Array<{
    uri: string;
    name?: string;
    description?: string;
    mimeType?: string;
    kind?: string;
    version?: string;
    /** Bytes, for a file listing. Carried as data — the human `description` may also say it. */
    size?: number;
    /** ISO timestamp of the last write, for a file listing. */
    modifiedAt?: string;
  }>,
): VerbResult => {
  const items = links.map((link) => ({
    type: 'resource_link' as const,
    uri: link.uri,
    name: link.name ?? link.uri,
    ...(link.description ? { description: link.description } : {}),
    ...(link.mimeType ? { mimeType: link.mimeType } : {}),
    ...(link.kind ? { kind: link.kind } : {}),
    ...(link.version ? { version: link.version } : {}),
    // Size and time are facts a caller acts on — "which asset is blowing the bundle
    // budget", "which project did I touch last" — so they travel as numbers rather
    // than only inside the prose `description`, which nobody can parse reliably.
    ...(link.size !== undefined ? { size: link.size } : {}),
    ...(link.modifiedAt ? { modifiedAt: link.modifiedAt } : {}),
  }));

  return items.length === 0
    ? { content: [{ type: 'text', text: EMPTY_LIST_TEXT }], emptyList: true }
    : { content: items };
};

/**
 * True for an `okLinks([])` result — a list that resolved to no children.
 *
 * Read off the `emptyList` flag, never the `(empty)` text: an app command may return that
 * string, and a `prependNote` puts a second block in front of the sentinel.
 */
export function isEmptyLinkList(result: VerbResult): boolean {
  return result.emptyList === true;
}

/**
 * Format multiple verb results into a single VerbResult with URI headers.
 * Used by brace-expansion in the exec() wrapper.
 */
export function formatBatchResults(
  uris: string[],
  settled: PromiseSettledResult<VerbResult>[],
): VerbResult {
  const content: VerbResult['content'] = [];
  let hasError = false;

  for (let i = 0; i < uris.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      if (s.value.isError) hasError = true;
      // Add URI header before each result's content
      content.push({ type: 'text', text: `--- ${uris[i]} ---` });
      content.push(...s.value.content);
    } else {
      hasError = true;
      content.push({ type: 'text', text: `--- ${uris[i]} ---` });
      content.push({
        type: 'text',
        text: s.reason instanceof Error ? s.reason.message : 'Unknown error',
      });
    }
  }

  return hasError ? { content, isError: true } : { content };
}
