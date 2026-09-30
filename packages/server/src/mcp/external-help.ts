/**
 * What a shared window's URL says about itself when it is fetched with GET.
 *
 * The URL is all an outside agent is handed, and the first thing anyone — a person pasting
 * it into a browser, an agent probing it with curl — does with a URL is GET it. A bare 405
 * there was a dead end: the revision, the two required headers and the `_meta` envelope
 * were each learned by being refused for lacking them. This page answers all of it in one
 * round trip, in markdown, which a browser shows and a model reads.
 *
 * The raw-request section is written from what the stateless handler actually enforces
 * (measured against `createMcpHandler`, SDK 2.0): `Content-Type: application/json`,
 * `Mcp-Method` on every request and `Mcp-Name` on `tools/call`, and a `_meta` carrying the
 * protocol version and client capabilities. `Accept` is not checked.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { firstSentence } from '../lib/protocol-index.js';

/** The one MCP revision YAAR serves (see `mcp/server.ts`). */
export const MCP_REVISION = '2026-07-28';

export interface SharedWindowHelp {
  /** The endpoint, exactly as the caller reached it. */
  url: string;
  appId: string;
  title: string;
  tools: { name: string; description?: string }[];
}

/** The `_meta` envelope every 2026-07-28 request carries. */
export function envelope(): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: MCP_REVISION,
    [CLIENT_CAPABILITIES_META_KEY]: {},
  };
}

/** A shell-quoted JSON body — the payloads here hold no single quotes. */
function quoteBody(body: unknown): string {
  return `'${JSON.stringify(body)}'`;
}

export function renderSharedWindowHelp({ url, appId, title, tools }: SharedWindowHelp): string {
  const serverName = `yaar-${appId}`.replace(/[^\w-]/g, '-');
  const listBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: { _meta: envelope() },
  };
  const describeBody = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'describe', arguments: {}, _meta: envelope() },
  };
  const toolLines = tools.map(
    (t) => `- \`${t.name}\`${t.description ? ` — ${firstSentence(t.description)}` : ''}`,
  );

  return [
    `# YAAR window: ${title}`,
    '',
    `This URL is an MCP endpoint bound to one window of a YAAR desktop — **${title}**, ` +
      `running the \`${appId}\` app. It serves that window's app-agent tools, with the ` +
      "app agent's authority: the app's protocol, its own storage, and what its app.json grants.",
    '',
    `- Transport: Streamable HTTP, POST only (this GET is the only other thing it answers)`,
    `- Protocol revision: ${MCP_REVISION}, stateless — no \`initialize\`, no session id`,
    '',
    '## Connect',
    '',
    '```sh',
    `claude mcp add --transport http ${serverName} ${url}`,
    '```',
    '',
    `Any MCP client that negotiates ${MCP_REVISION} works. An older one is refused with a ` +
      'message naming the setting it lacks.',
    '',
    '## Start here',
    '',
    "Call `describe` first: it returns the app's manual — its state keys and its commands with " +
      'their signatures. Then `query` reads state and `command` runs commands. ' +
      '`query` with `stateKey: "__screenshot"` shows what the window looks like right now.',
    '',
    '## Tools',
    '',
    ...toolLines,
    '',
    '## Raw requests',
    '',
    'Every request is a standalone POST carrying:',
    '',
    '- `Content-Type: application/json`',
    '- `Mcp-Method: <the JSON-RPC method>`, and `Mcp-Name: <tool name>` on `tools/call`',
    `- \`params._meta\` with \`"${PROTOCOL_VERSION_META_KEY}": "${MCP_REVISION}"\` and ` +
      `\`"${CLIENT_CAPABILITIES_META_KEY}"\` (\`{}\` will do)`,
    '',
    '```sh',
    `curl -s ${url} \\`,
    `  -H 'Content-Type: application/json' -H 'Mcp-Method: tools/list' \\`,
    `  -d ${quoteBody(listBody)}`,
    '',
    `curl -s ${url} \\`,
    `  -H 'Content-Type: application/json' -H 'Mcp-Method: tools/call' -H 'Mcp-Name: describe' \\`,
    `  -d ${quoteBody(describeBody)}`,
    '```',
    '',
    '## This URL is the credential',
    '',
    'Anyone holding it can drive this window as its app agent — keep it out of places you ' +
      'would not paste a password. It has no expiry of its own; it stops working when:',
    '',
    '- the window is closed,',
    "- the user right-clicks the share button in the window's titlebar (stop sharing), or",
    '- YAAR restarts.',
    '',
    'After that this URL answers 404.',
    '',
  ].join('\n');
}
