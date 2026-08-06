/**
 * One session-principal policy, behind both doors.
 *
 * `yaar://session/*` is the session agent's private namespace, and it used to be
 * guarded by two gates that answered in different currencies: `http/access.ts` asked
 * the iframe token's `systemApp` flag, while `ResourceRegistry.execute` asked the
 * caller's agent `role`. A bundled system app satisfied the first and failed the
 * second, so the only reason Process Explorer worked was that the two agent
 * registrations were never tagged at all.
 *
 * The registry gate is now the authority — both doors end there — and it admits the
 * session agent *or* a token-backed bundled system app. What must stay true:
 *
 *   - a system app's iframe reaches a tagged handler through `POST /api/verb`;
 *   - the flag reaching the gate comes off the validated token, so a request body
 *     cannot supply it;
 *   - an ordinary app is refused at *both* doors, not just one;
 *   - a monitor agent, which never passes the HTTP door at all, is still refused.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { handleVerbRoutes } from '../http/routes/verb.js';
import { initRegistry } from '../handlers/index.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import {
  getAccessPrincipal,
  runWithAgentContext,
  type AgentRole,
} from '../agents/agent-context.js';
import { setAccessPrincipalResolver } from '../handlers/uri-registry.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'sess-principal' as SessionId;

/**
 * `yaar://session` — tagged `access: 'session-principal'`, and the one such handler
 * whose `read` needs no live session or pool, so a door test can assert the *gate*
 * without booting the hub.
 */
const URI = 'yaar://session';

// Production wires this in lifecycle.ts, which a unit test does not run. Installing the
// real resolver (rather than a fake) is what keeps this file and registry.test.ts from
// fighting over a process-global in the concurrent unit partition.
beforeAll(() => {
  setAccessPrincipalResolver(getAccessPrincipal);
  initRegistry();
});

/** A token for an iframe that declares `yaar://session/`, system app or not. */
function tokenFor(systemApp: boolean): string {
  return generateIframeToken(`win-${systemApp ? 'sys' : 'plain'}`, SESSION, {
    appId: systemApp ? 'process-explorer' : 'notes',
    permissions: ['yaar://session/'],
    monitorId: '0',
    systemApp,
  });
}

/** `POST /api/verb` exactly as an app's SDK sends it. */
async function postVerb(token: string, body: Record<string, unknown>): Promise<Response> {
  const req = new Request('http://localhost:8000/api/verb', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-iframe-token': token },
    body: JSON.stringify(body),
  });
  const res = await handleVerbRoutes(req, new URL(req.url));
  if (!res) throw new Error('route did not handle POST /api/verb');
  return res;
}

describe('session-principal: one policy, two doors', () => {
  it('lets a bundled system app read a session-principal resource', async () => {
    const res = await postVerb(tokenFor(true), { verb: 'read', uri: URI });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data?: { platform?: string } };
    expect(body.ok).toBe(true);
    // The handler ran — this is its payload, not a gate message.
    expect(body.data?.platform).toBe(process.platform);
  });

  it('refuses an ordinary app at the HTTP door', async () => {
    const res = await postVerb(tokenFor(false), { verb: 'read', uri: URI });
    expect(res.status).toBe(403);
  });

  it('refuses an ordinary app at the registry gate too, not only at the HTTP door', async () => {
    // The HTTP door is a cheap early refusal; this is what a caller that got past it
    // would meet. Entered exactly as routes/verb.ts enters it, minus the flag.
    const result = await runWithAgentContext(
      { agentId: 'iframe:notes', sessionId: SESSION, appId: 'notes', systemApp: false },
      () => initRegistry().execute('read', URI),
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Access denied');
  });

  it('takes systemApp from the token, not from the request body', async () => {
    const res = await postVerb(tokenFor(false), { verb: 'read', uri: URI, systemApp: true });
    expect(res.status).toBe(403);
  });

  it('refuses monitor and app agents at the MCP door', async () => {
    for (const role of ['monitor', 'app'] as AgentRole[]) {
      const result = await runWithAgentContext(
        { agentId: `${role}-agent`, sessionId: SESSION, role },
        () => initRegistry().execute('read', URI),
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('Access denied');
    }
  });

  it('still lets the session agent through', async () => {
    const result = await runWithAgentContext(
      { agentId: 'session-agent', sessionId: SESSION, role: 'session' },
      () => initRegistry().execute('read', URI),
    );
    expect(result.isError).toBeUndefined();
  });
});

describe('yaar://session/agents is tagged like the rest of the namespace', () => {
  // The audit's finding: these two registrations were the only yaar://session/*
  // handlers with no `access` tag, so a monitor or app *agent* — which never meets
  // http/access.ts — could list and interrupt every agent in the session.
  const AGENT_URIS = ['yaar://session/agents', 'yaar://session/agents/some-agent'];

  it('refuses a monitor agent on both agent registrations', async () => {
    for (const uri of AGENT_URIS) {
      const result = await runWithAgentContext(
        { agentId: 'monitor-0', sessionId: SESSION, role: 'monitor' },
        () => initRegistry().execute(uri.endsWith('agents') ? 'list' : 'read', uri),
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('Access denied');
    }
  });

  it('admits a system app, which is how Process Explorer keeps working', async () => {
    // The handler asks for the live session on its first line, and this process has
    // none — so `NoActiveSessionError` *is* the proof it was reached. A refusal is a
    // returned VerbResult, never a throw, so the two outcomes cannot be confused.
    const listAgents = () =>
      runWithAgentContext(
        {
          agentId: 'iframe:process-explorer',
          sessionId: SESSION,
          appId: 'process-explorer',
          systemApp: true,
        },
        () => initRegistry().execute('list', 'yaar://session/agents'),
      );
    expect(listAgents()).rejects.toThrow('No active session');
  });
});
