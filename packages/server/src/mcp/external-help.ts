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
 * protocol version and client capabilities. `Accept` is not checked. The same list, run
 * against one POST, is {@link missingFromRawRequest}: a refused request is told every gap at
 * once and pointed back here.
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

/**
 * Everything a raw POST to a shared window's URL lacks, all at once — the page above as a
 * checklist, run against one request.
 *
 * The handler refuses one thing per round trip, and not in the order a person fixes them:
 * a body without `_meta` is classified as the 2025 era and refused with advice about CLI
 * opt-in gates; then each envelope key, then `Mcp-Method`, then `Mcp-Name`. An outside
 * agent writing requests by hand measured four 400s before its first answer. This names
 * every gap in one answer, and the refusal points at the GET page with working examples.
 *
 * A checklist, not the validator: a request it passes still goes to the handler, whose
 * own 400 (for a check this list does not know) gets the same pointer appended
 * (`withGuide`). A batch is not inspected.
 */
export function missingFromRawRequest(headers: Headers, body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const { method, params } = body as { method?: unknown; params?: Record<string, unknown> };
  if (typeof method !== 'string') return [];
  if (method === 'initialize') {
    return [
      `no \`initialize\`: revision ${MCP_REVISION} is stateless — send \`tools/list\` or ` +
        '`tools/call` directly, each carrying what the other items here list',
    ];
  }
  const missing: string[] = [];

  if (!(headers.get('content-type') ?? '').includes('application/json')) {
    missing.push('header `Content-Type: application/json`');
  }
  const methodHeader = headers.get('mcp-method');
  if (!methodHeader) missing.push(`header \`Mcp-Method: ${method}\``);
  else if (methodHeader !== method) {
    missing.push(
      `header \`Mcp-Method: ${method}\` — it says "${methodHeader}", the body says "${method}"`,
    );
  }
  if (method === 'tools/call') {
    const name = typeof params?.name === 'string' ? params.name : '<tool name>';
    const nameHeader = headers.get('mcp-name');
    if (!nameHeader) missing.push(`header \`Mcp-Name: ${name}\``);
    else if (nameHeader !== name) {
      missing.push(
        `header \`Mcp-Name: ${name}\` — it says "${nameHeader}", the body says "${name}"`,
      );
    }
  }
  if (!method.startsWith('notifications/')) {
    const meta = params?._meta as Record<string, unknown> | undefined;
    const version = meta?.[PROTOCOL_VERSION_META_KEY];
    if (version !== MCP_REVISION) {
      missing.push(
        `\`params._meta["${PROTOCOL_VERSION_META_KEY}"]: "${MCP_REVISION}"\`` +
          (version === undefined ? '' : ` — it says ${JSON.stringify(version)}`),
      );
    }
    if (!meta || typeof meta[CLIENT_CAPABILITIES_META_KEY] !== 'object') {
      missing.push(`\`params._meta["${CLIENT_CAPABILITIES_META_KEY}"]\` (\`{}\` will do)`);
    }
  }
  return missing;
}

/** The sentence every refusal on this door ends with. */
export function guidePointer(url: string): string {
  return `GET ${url} for the raw-request guide, with working curl examples.`;
}

/** One 400 naming every gap {@link missingFromRawRequest} found. */
export function refuseIncomplete(url: string, id: unknown, missing: string[]): Response {
  const message =
    `This request needs ${missing.length} more thing${missing.length === 1 ? '' : 's'} ` +
    `(fix all, then resend): ${missing.map((m, i) => `(${i + 1}) ${m}`).join('; ')}. ` +
    guidePointer(url);
  return Response.json(
    {
      jsonrpc: '2.0',
      error: { code: -32600, message, data: { missing, guide: url } },
      id: id ?? null,
    },
    { status: 400 },
  );
}

/**
 * A handler's 400, with {@link guidePointer} appended to its message — for a refusal the
 * checklist did not predict. Anything else, or a body that is not a JSON-RPC error, is
 * returned untouched.
 */
export async function withGuide(res: Response, url: string): Promise<Response> {
  if (res.status !== 400 || !(res.headers.get('content-type') ?? '').includes('json')) return res;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: { message?: unknown; data?: unknown } } | null;
  if (!body?.error || typeof body.error.message !== 'string') return res;
  const data = body.error.data && typeof body.error.data === 'object' ? body.error.data : {};
  // `refuseIncomplete`'s own answer already points there.
  if ('guide' in data) return res;
  body.error = {
    ...body.error,
    message: `${body.error.message} ${guidePointer(url)}`,
    data: { ...data, guide: url },
  };
  return Response.json(body, { status: 400 });
}
