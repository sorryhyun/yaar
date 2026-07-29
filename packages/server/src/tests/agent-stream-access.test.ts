/**
 * The gate on streaming an agent's transcript.
 *
 * `yaar://agents/{id}/stream` is a live transcript — prompts, thinking, tool
 * inputs and results — so an app may open it only if it declared `streams:
 * ["agents"]` in its app.json — and, if it was installed rather than bundled, only
 * as far as the user granted at install (see `app-capabilities.test.ts`). That
 * declaration rides the iframe
 * token; `requireStream` checks it. The session agent's own stream is shielded
 * separately in the subscribe route (it needs a live pool), so this pins the two
 * pieces that stand alone: the URI parse and the capability check.
 */
import { describe, it, expect } from 'bun:test';
import { requireStream, resolvePrincipal } from '../http/access.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import { parseAgentStreamUri } from '../streams/agent-stream.js';

function principalFor(streams?: string[]) {
  const token = generateIframeToken('win-1', 'sess-1', { appId: 'process-explorer', streams });
  const req = new Request('http://127.0.0.1:8000/api/verb/subscribe', {
    headers: { 'x-iframe-token': token },
  });
  const principal = resolvePrincipal(req, new URL(req.url));
  if (principal instanceof Response) throw new Error('principal was denied');
  return principal;
}

describe('agent stream access', () => {
  it('parses only a fully-formed agent stream URI', () => {
    expect(parseAgentStreamUri('yaar://agents/agent-3/stream')).toBe('agent-3');
    // The roster URI is not a stream; neither is an agent URI without /stream.
    expect(parseAgentStreamUri('yaar://session/agents')).toBeNull();
    expect(parseAgentStreamUri('yaar://agents/agent-3')).toBeNull();
    expect(parseAgentStreamUri('yaar://dev/deploy/demo')).toBeNull();
  });

  it('lets an app that declared streams:["agents"] stream an agent', () => {
    expect(requireStream(principalFor(['agents']), 'agents')).toBeNull();
  });

  it('denies an app that did not declare the capability', () => {
    // No declaration — the roster is visible, the transcript is not.
    expect(requireStream(principalFor(undefined), 'agents')?.status).toBe(403);
    // A declaration for some other capability does not grant "agents".
    expect(requireStream(principalFor(['windows']), 'agents')?.status).toBe(403);
  });
});
