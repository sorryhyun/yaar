/**
 * Codex per-thread MCP scope — which namespaces a turn's thread actually connects to.
 *
 * Two things make this the only place the answer is decided, and both are invisible from
 * the type system:
 *
 * 1. A thread's `mcp_servers` override **merges** over the app-server's loaded config
 *    rather than replacing it (observed: a server declared only in the user's
 *    `~/.codex/config.toml` still starts for a thread whose override never names it). So a
 *    namespace declared at the process level cannot be withheld per thread — which is why
 *    `getCodexAppServerArgs()` declares none, and why a test that only asserted on the
 *    override map would pass while the containment it claims to check did not hold.
 * 2. Codex ignores `allowedTools` — it has no per-tool filter. Whole namespaces are the
 *    only granularity it has, and `codexServerFilter` is where that translation lives.
 *
 * Driven through the real `CodexProvider.query()` with a fake JSON-RPC client, so what is
 * asserted is the params actually sent — on every call that opens a thread, `thread/resume`
 * included. A resume that omits `config` is the same bug as declaring the wrong namespaces,
 * just spelled as an absence.
 */
import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { CodexProvider } from '../providers/codex/provider.js';
import { getCodexAppServerArgs } from '../config/providers/codex.js';
import { SUB_AGENT_MCP_SERVER } from '../agents/profiles/sub-agent.js';
import type { AppServer } from '../providers/codex/app-server.js';
import type { JsonRpcWsClient } from '../providers/codex/jsonrpc-ws-client.js';

/** A fake app-server WS client that records requests and completes every turn. */
class FakeClient extends EventEmitter {
  isConnected = true;
  readonly requests: Array<{ method: string; params: any }> = [];

  async request(method: string, params?: any): Promise<any> {
    this.requests.push({ method, params });
    switch (method) {
      case 'thread/start':
        return { thread: { id: 'thread-1' } };
      case 'thread/resume':
        // A non-empty `turns` is what makes the provider keep the resumed thread rather
        // than fall through to `thread/start`.
        return { thread: { id: params.threadId, turns: [{ id: 'turn-0' }] } };
      case 'turn/start':
        setTimeout(() => {
          this.emit('notification', 'turn/completed', { turn: { status: 'completed' } });
        }, 0);
        return { turn: { id: 'turn-1' } };
      default:
        return {};
    }
  }

  respond(): void {}
  respondError(): void {}
  close(): void {}
}

/** Run one turn and return the recorded requests. */
async function runTurn(
  options: { allowedTools?: string[]; resumeThreadId?: string } = {},
): Promise<FakeClient> {
  const fake = new FakeClient();
  const appServer = {
    isRunning: true,
    createConnection: async () => fake,
  } as unknown as AppServer;
  const provider = new CodexProvider(appServer);
  (provider as unknown as { client: JsonRpcWsClient }).client = fake as unknown as JsonRpcWsClient;

  for await (const _ of provider.query('hi', {
    systemPrompt: 'sp',
    agentId: 'agent-1',
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
    ...(options.resumeThreadId ? { resumeThread: true, sessionId: options.resumeThreadId } : {}),
  })) {
    // drain
  }

  return fake;
}

/** Run one turn and return the `mcp_servers` map the thread was started with. */
async function scopeFor(allowedTools?: string[]): Promise<Record<string, any>> {
  const fake = await runTurn(allowedTools ? { allowedTools } : {});
  const start = fake.requests.find((r) => r.method === 'thread/start');
  return start!.params.config.mcp_servers as Record<string, any>;
}

describe('codex per-thread MCP scope', () => {
  it('gives a sub-agent turn its own namespace and nothing else', async () => {
    const servers = await scopeFor(['mcp__subagent__remember', 'mcp__subagent__skip']);

    // The containment: a persona reaches its own app's iframe and no YAAR verb.
    expect(Object.keys(servers)).toEqual([SUB_AGENT_MCP_SERVER]);
  });

  it('gives a tool-less sub-agent no servers at all', async () => {
    // Empty means *no tools*, not "unfiltered" — the same distinction buildSDKOptions
    // draws on the Claude side. A sub-agent that receives text and returns text.
    const servers = await scopeFor([]);

    expect(Object.keys(servers)).toEqual([]);
  });

  it('gives an unfiltered turn every namespace except subagent', async () => {
    const servers = await scopeFor(undefined);
    const names = Object.keys(servers);

    // Monitor/app agents pass no allowlist and keep the full surface...
    expect(names).toContain('verbs');
    expect(names).toContain('app');
    expect(names).toContain('system');
    expect(names).toContain('messaging');
    // ...except the one namespace that is empty for anyone but a sub-agent. Attaching it
    // produced a server advertising a `tools` capability with no handler behind it, which
    // codex reports as `-32601 Method not found` and marks failed.
    expect(names).not.toContain(SUB_AGENT_MCP_SERVER);
  });

  it('stamps the caller identity on every server it does attach', async () => {
    const servers = await scopeFor(undefined);

    for (const config of Object.values(servers)) {
      expect(config.http_headers['x-agent-token']).toBeTruthy();
      expect(config.bearer_token_env_var).toBe('YAAR_MCP_TOKEN');
    }
  });

  it('carries the same scope onto a resumed thread', async () => {
    // A thread's server set is decided when the thread is opened, and `thread/start` is not
    // the only way to open one: restoring a previous run's session log makes the first turn
    // a `thread/resume`. That call used to send no `config`, which was invisible while the
    // process-level set still existed — the resumed thread inherited the servers from the
    // loaded config. Once that set was emptied (the assertion below), a resumed thread got
    // zero YAAR namespaces and the agent answered as if MCP did not exist.
    const fake = await runTurn({ resumeThreadId: 'thread-from-a-previous-run' });

    const resume = fake.requests.find((r) => r.method === 'thread/resume');
    expect(resume).toBeDefined();
    // It really resumed — a fall-through to thread/start would satisfy a scope assertion
    // while proving nothing about the resume path.
    expect(fake.requests.find((r) => r.method === 'thread/start')).toBeUndefined();

    const names = Object.keys(resume!.params.config.mcp_servers);
    expect(names).toContain('verbs');
    expect(names).toContain('app');
    expect(names).toContain('system');
    expect(names).toContain('messaging');
  });

  it('declares no MCP servers at the process level, and only ever takes them away', () => {
    // The override merges rather than replaces, so anything declared here would ride along
    // on every thread — including a sub-agent's — no matter what the per-thread filter says.
    // The one permitted process-level `mcp_servers` line is the inverse: `enabled=false`,
    // which is how a server the *user's* ~/.codex/config.toml declares gets taken away —
    // per-thread it could not be.
    //
    // The rule, not a roster: which servers are named is `DISABLED_MCP_SERVERS`'s business
    // (currently none — the block is commented out in `config/providers/codex.ts`), and
    // asserting the two entries it used to carry made this fail the moment that changed
    // while the containment it exists to guard still held perfectly. What must never
    // change is the *shape*: a takeaway is the only thing this list may contain.
    const mcpArgs = getCodexAppServerArgs().filter((a) => a.includes('mcp_servers'));
    for (const arg of mcpArgs) {
      expect(arg).toMatch(/^mcp_servers\.[^.]+\.enabled=false$/);
    }
  });
});
