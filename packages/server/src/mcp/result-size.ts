/**
 * The per-tool persist-to-disk threshold YAAR declares on its MCP tools.
 *
 * ## The cliff this exists to move
 *
 * When a tool result is larger than the calling CLI's threshold, Claude Code writes it to
 * `~/.claude/projects/{…}/tool-results/{id}.txt` and hands the model a 2 KB preview plus the
 * path. For a YAAR principal that is a **total** loss, not a degradation: monitor agents hold
 * the five `yaar://` verbs and app agents hold four scoped tools — neither has a filesystem
 * read, so the pointer resolves to nothing (`No handler registered for URI: /home/…`). The
 * incident that first named this was a 63.7 KB `describe('yaar://apps/{id}')`, which is what
 * split the protocol onto its own URI (`handlers/apps/protocol-resource.ts`); issue #64 is the
 * same cliff reached from the app-agent side, via a batched `command`.
 *
 * That split could only assume the threshold was "undocumented, unpinned, observed somewhere
 * between 51 KB and 64 KB", and that YAAR's job was to stay conservatively under it. Both
 * halves of that are wrong, and this module is the correction:
 *
 * - **The number is 50,000 characters**, and it is not `MAX_MCP_OUTPUT_TOKENS`. YAAR already
 *   sets that to 131072 (`config/providers/claude.ts`) and it never touched this: the token
 *   var governs image content and the over-size *warning*, while the persist decision is
 *   `Math.min(tool.maxResultSizeChars, 50000)` in characters. An MCP tool's default
 *   `maxResultSizeChars` is 100,000, so the 50,000 clamp is what every unannotated tool gets.
 * - **A server can raise its own threshold**, by declaring
 *   `_meta["anthropic/maxResultSizeChars"]` on the tool's `tools/list` entry. Claude Code then
 *   uses that value for text content instead of the clamp, up to a hard ceiling of 500,000.
 *   This is documented at https://code.claude.com/docs/en/mcp#raise-the-limit-for-a-specific-tool
 *   and is exactly the escape hatch a server whose callers cannot read files needs.
 *
 * ## Why 150,000 and not the 500,000 the ceiling allows
 *
 * There is a **second** budget, and it is not annotatable. Independently of the per-tool
 * threshold, the CLI enforces ~200,000 characters across all tool results attached to one
 * assistant message, persisting the largest first until the group fits. A tool annotated at
 * 400,000 would clear the per-tool check and then be persisted anyway by the group pass — so
 * 200,000 is the real usable maximum however high the ceiling goes, and a lone result *at*
 * 200,000 leaves no room for a sibling call in the same turn.
 *
 * 150,000 is that maximum with a sibling's worth of headroom: 3x the CLI's clamp, ~2.5x the
 * 58.7 KB batch in issue #64, and ~37k tokens — steep for one result, which is the point of it
 * being a ceiling rather than a target. Staying small is still the better answer wherever YAAR
 * can choose (the protocol doors in `handlers/apps/protocol-resource.ts` did exactly that, and
 * should stay that way); this only decides what happens to the reads YAAR does not control,
 * where the alternative is losing them entirely.
 *
 * ## Scope
 *
 * Declared on the tools that carry resource or app content back to a model — the four verbs
 * that return something (`describe`/`read`/`list`/`invoke`) and the three app-agent doors
 * (`describe`/`query`/`command`). Deliberately not on `delete` or `relay`, whose results are
 * fixed-size acknowledgements, nor on the system/messaging tools, whose payloads are bounded
 * by what YAAR itself composes.
 *
 * The threshold is measured against the *serialized* result — the content array is
 * pretty-printed JSON when it is persisted — so escaping and block framing eat into it. Treat
 * 150,000 as the budget for the envelope, not for the text inside it.
 *
 * Non-Claude clients ignore the key: `_meta` is free-form in the MCP spec, so this is inert
 * for Codex rather than something that needs a provider fork.
 */
export const MCP_MAX_RESULT_CHARS = 150_000;

/**
 * The `_meta` block to spread into a `registerTool` config so the tool declares
 * {@link MCP_MAX_RESULT_CHARS} as its own threshold. Spread rather than copied, so the key
 * spelling lives in exactly one place.
 */
export const LARGE_RESULT_META = {
  'anthropic/maxResultSizeChars': MCP_MAX_RESULT_CHARS,
} as const;
