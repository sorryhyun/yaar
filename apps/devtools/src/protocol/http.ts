/**
 * One outbound HTTP request, for probing an API while building against it.
 *
 * Dev Tools has declared `yaar://http` since it shipped, but nothing on its protocol
 * could use it: `inspectUri` is describe/read/list against `yaar://` resources, and no
 * other command issues a request. An agent that needed to see what an endpoint actually
 * answers had to drive the Lab app through `controls` and reverse-engineer its in-sandbox
 * `http` helper — two apps and a window to make one GET (issue #65).
 *
 * It runs **in the iframe**, like `shared-tree.ts`'s commands and for the same reason: the app
 * agent holds no verb tools, so it asks this app to do what this app's declared,
 * user-visible permission already allows, through a named command that appears in
 * `dist/protocol.json`. Allowlist and SSRF checks stay server-side either way.
 *
 * This is a *probe*, not a fetch library. A response can be 10 MB, and a command result
 * lands whole in a model context, so the body comes back as a bounded window with the
 * real length beside it — page through with `offset` rather than asking for all of it.
 * A non-text response is reported, never dumped: base64 in a transcript is unreadable
 * and would be the largest thing in it.
 */

import { AppCommandError, errMsg, httpFetch, defineAppCommand } from '@bundled/yaar';

/**
 * Enough to see a JSON envelope's shape or an HTML page's head, and small enough that
 * probing four candidate endpoints costs less than reading one source file.
 */
const DEFAULT_MAX_CHARS = 4000;

/**
 * The ceiling on one slice. Past this the answer is not "read it in the transcript" but
 * "narrow the request" — a query parameter, a Range header, another `offset`.
 */
const MAX_CHARS = 50_000;

/** Content types worth returning as text. Anything else is described, not transcribed. */
const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|.*\+json|.*\+xml))/i;

function clampChars(raw: unknown): number {
  if (raw == null) return DEFAULT_MAX_CHARS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CHARS;
  return Math.min(Math.floor(n), MAX_CHARS);
}

function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export const httpCommands = {
  httpProbe: defineAppCommand({
    description:
      'Make one outbound HTTP request and return its status, headers and a bounded slice ' +
      'of the body — for learning what an API accepts and answers while building against ' +
      'it. Cross-origin domains need the user\'s allowlist approval, and a denial comes ' +
      'back as an error naming the domain. The body is capped: `bodyChars` is the real ' +
      'length, `slice` is what was returned, and `offset` pages through the rest. A ' +
      'non-text response (image, zip) reports its type and size instead of its bytes. ' +
      'Not a way to download a file into the project — nothing here writes to disk.',
    params: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL (http/https)' },
        method: { type: 'string', description: 'HTTP method. Default GET.' },
        headers: {
          type: 'object',
          description: 'Request headers, e.g. { "User-Agent": "...", "Accept": "..." }',
          additionalProperties: { type: 'string' },
        },
        body: { type: 'string', description: 'Request body, for POST/PUT/PATCH.' },
        redirect: {
          type: 'string',
          enum: ['follow', 'manual'],
          description:
            '"manual" returns the 3xx and its Location header instead of following it — ' +
            'the way to see whether an endpoint redirects at all. Default "follow".',
        },
        maxChars: {
          type: 'number',
          description: `Body characters to return. Default ${DEFAULT_MAX_CHARS}, max ${MAX_CHARS}.`,
        },
        offset: {
          type: 'number',
          description: 'Body character to start the slice at. Default 0.',
        },
      },
      required: ['url'],
    },
    run: async (p) => {
      const url = String(p.url ?? '').trim();
      if (!url) throw new AppCommandError('httpProbe needs a `url`.');
      if (!/^https?:\/\//i.test(url))
        throw new AppCommandError(
          `httpProbe needs an absolute http(s) URL; got "${url}". A yaar:// resource is ` +
            'inspectUri\'s job, not this one.',
        );

      const maxChars = clampChars(p.maxChars);
      const offset = Math.max(0, Number(p.offset ?? 0) || 0);
      const method = typeof p.method === 'string' && p.method ? p.method.toUpperCase() : 'GET';

      const init: RequestInit = { method };
      if (p.headers && typeof p.headers === 'object')
        init.headers = p.headers as Record<string, string>;
      if (typeof p.body === 'string' && method !== 'GET' && method !== 'HEAD') init.body = p.body;
      if (p.redirect === 'manual') init.redirect = 'manual';

      let res: Response;
      try {
        res = await httpFetch(url, init);
      } catch (err) {
        // The allowlist denial, an SSRF refusal and a dead host all arrive here. The
        // message is the server's and already says which — passing it through beats
        // "request failed", which sends the caller back to guessing.
        throw new AppCommandError(`httpProbe ${method} ${url} failed: ${errMsg(err)}`);
      }

      const headers = headerMap(res.headers);
      const contentType = headers['content-type'] ?? '';
      // No `redirected` / final `url`: a cross-origin response is rebuilt from the
      // proxy's JSON envelope by `new Response(...)`, whose `redirected` is always
      // false and whose `url` is always empty. Reporting either would be a fact the
      // caller could act on and that is never true. `redirect: 'manual'` answers the
      // question honestly instead — the 3xx and its Location land in `headers`.
      const head = {
        url,
        method,
        status: res.status,
        statusText: res.statusText,
        ok: res.ok,
        headers,
      };

      if (contentType && !TEXT_TYPE.test(contentType)) {
        // Binary. Reading the bytes here would only put base64 in the transcript, and
        // there is no tool on this side that could do anything with them — so report
        // the shape and stop, rather than pretending the body came back.
        const buf = await res.arrayBuffer().catch(() => null);
        return {
          ...head,
          binary: true,
          contentType,
          bytes: buf?.byteLength ?? null,
          note:
            'Non-text response — bytes are not returned. Use the shared-tree commands to import ' +
            'an asset into the project, or an app that can fetch it directly.',
        };
      }

      const text = await res.text().catch(() => '');
      const slice = text.slice(offset, offset + maxChars);
      return {
        ...head,
        contentType: contentType || null,
        bodyChars: text.length,
        slice: {
          offset,
          length: slice.length,
          // The two ends are separate facts: `truncated` says more follows, `offset`
          // past the end says the caller paged off the end and got nothing.
          truncated: offset + slice.length < text.length,
        },
        body: slice,
      };
    },
  }),
};
