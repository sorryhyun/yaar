/**
 * One copy of every answer on the shared-window door (`/mcp/window/{token}`).
 *
 * `okJson` and `wrapAppValue` answer an object twice: the object in `structuredContent`, and
 * its JSON again as a text block (indented or truncated, for the session log). YAAR's own
 * clients never hand a model both — the Claude CLI sends `JSON.stringify(structuredContent)`
 * in place of every text block, Codex the serialized object alone (see `okJson`) — so inside
 * YAAR the mirror costs bytes, not tokens. A shared window's caller is any client, though,
 * and one that reads both fields paid for a 15 KB `describe` twice.
 *
 * So this door answers with the view YAAR's own agents get, in the one field every client
 * reads: non-text blocks kept, the text blocks replaced by the object's compact JSON, and no
 * `structuredContent`. The text rather than the object survives because a client may read
 * `content` alone and none may read `structuredContent` alone. Nothing is lost: notes ride
 * inside the object as `_notes` (`foldNotes`), and the object is the untruncated copy. No
 * tool on this door declares an `outputSchema`, so an answer without `structuredContent` is
 * legal on the wire.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { foldNotes, type VerbResult } from '../lib/verb-result.js';

/** A tool answer as it leaves for an outside client: one copy, in `content`. */
export function singleCopy<T extends VerbResult>(result: T): T {
  if (!result.structuredContent) return result;
  const { structuredContent, ...rest } = foldNotes(result);
  return {
    ...rest,
    content: [
      ...rest.content.filter((block) => block.type !== 'text'),
      { type: 'text', text: JSON.stringify(structuredContent) },
    ],
  } as T;
}

type ToolCallback = (...args: unknown[]) => unknown;

/**
 * Make every tool registered on `server` from here on answer through {@link singleCopy}.
 *
 * A wrapper at registration rather than a pass over the HTTP response: the response may be
 * JSON or an event stream, and the tool modules are shared with the app agent's own door,
 * which must keep `structuredContent` for `POST /api/verb` and `resolveAppWindow`.
 */
export function answerOnce(server: McpServer): McpServer {
  const register = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    cb: ToolCallback,
  ) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, cb) =>
    register(name, config, async (...args) => singleCopy((await cb(...args)) as VerbResult));
  return server;
}
