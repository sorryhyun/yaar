/**
 * Codex carries the conversation across a changed thread setup (B8).
 *
 * The system prompt carries the environment section — installed apps, settings — so
 * installing an app changes it between two turns of the same agent. A thread's
 * instructions, model and MCP servers are fixed when it is opened, so the provider must
 * open another; it used to `thread/start` one, which silently dropped everything the agent
 * had been told. It now forks the current thread onto the new setup, and falls back to
 * `thread/start` only when there is nothing to fork (a thread that never ran a turn has no
 * rollout: app-server answers `-32600 no rollout found`).
 *
 * Driven through the real `CodexProvider.query()` with a fake JSON-RPC client, asserting
 * on the requests actually sent.
 */
import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { CodexProvider } from '../providers/codex/provider.js';
import { JsonRpcError } from '../providers/codex/jsonrpc-ws-client.js';
import type { AppServer } from '../providers/codex/app-server.js';
import type { JsonRpcWsClient } from '../providers/codex/jsonrpc-ws-client.js';
import type { StreamMessage } from '../providers/types.js';

class FakeClient extends EventEmitter {
  isConnected = true;
  readonly requests: Array<{ method: string; params: any }> = [];
  private threads = 0;

  constructor(private readonly forkFails = false) {
    super();
  }

  async request(method: string, params?: any): Promise<any> {
    this.requests.push({ method, params });
    switch (method) {
      case 'thread/start':
        return { thread: { id: `started-${++this.threads}` } };
      case 'thread/fork':
        if (this.forkFails) {
          throw new JsonRpcError(
            method,
            -32600,
            `no rollout found for thread id ${params.threadId}`,
          );
        }
        return { thread: { id: `forked-${++this.threads}` } };
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

function makeProvider(fake: FakeClient): CodexProvider {
  const appServer = { isRunning: true, createConnection: async () => fake } as unknown as AppServer;
  const provider = new CodexProvider(appServer);
  (provider as unknown as { client: JsonRpcWsClient }).client = fake as unknown as JsonRpcWsClient;
  return provider;
}

/** Run one turn; return the session ids the provider reported. */
async function turn(
  provider: CodexProvider,
  systemPrompt: string,
  extra: { model?: string; allowedTools?: string[] } = {},
): Promise<string[]> {
  const ids: string[] = [];
  for await (const m of provider.query('hi', {
    systemPrompt,
    agentId: 'agent-1',
    conversation: { kind: 'new' },
    ...extra,
  }) as AsyncIterable<StreamMessage>) {
    if (m.type === 'session' && m.sessionId) ids.push(m.sessionId);
  }
  return ids;
}

const methods = (fake: FakeClient) =>
  fake.requests.map((r) => r.method).filter((m) => m.startsWith('thread/'));

describe('codex thread across a changed setup', () => {
  it('forks the current thread when the system prompt changes', async () => {
    const fake = new FakeClient();
    const provider = makeProvider(fake);

    expect(await turn(provider, 'prompt with apps [a]')).toEqual(['started-1']);
    expect(await turn(provider, 'prompt with apps [a, b]')).toEqual(['forked-2']);

    expect(methods(fake)).toEqual(['thread/start', 'thread/fork']);
    const fork = fake.requests.find((r) => r.method === 'thread/fork')!;
    expect(fork.params.threadId).toBe('started-1');
    expect(fork.params.baseInstructions).toBe('prompt with apps [a, b]');
    // The fork is a fresh open, so it must carry the MCP servers like thread/start does.
    expect(Object.keys(fork.params.config.mcp_servers).length).toBeGreaterThan(0);

    // The next turn runs on the fork.
    const lastTurn = fake.requests.filter((r) => r.method === 'turn/start').at(-1)!;
    expect(lastTurn.params.threadId).toBe('forked-2');
  });

  it('forks onto a new model and a new MCP scope too', async () => {
    const fake = new FakeClient();
    const provider = makeProvider(fake);

    await turn(provider, 'sp');
    await turn(provider, 'sp', { model: 'other-model' });
    await turn(provider, 'sp', { model: 'other-model', allowedTools: ['mcp__system__read'] });

    expect(methods(fake)).toEqual(['thread/start', 'thread/fork', 'thread/fork']);
    const [modelFork, scopeFork] = fake.requests.filter((r) => r.method === 'thread/fork');
    expect(modelFork.params.model).toBe('other-model');
    expect(Object.keys(scopeFork.params.config.mcp_servers)).toEqual(['system']);
  });

  it('keeps the thread when nothing changed', async () => {
    const fake = new FakeClient();
    const provider = makeProvider(fake);

    await turn(provider, 'sp');
    expect(await turn(provider, 'sp')).toEqual([]);
    expect(methods(fake)).toEqual(['thread/start']);
  });

  it('starts a new thread when the current one has nothing to fork', async () => {
    const fake = new FakeClient(true);
    const provider = makeProvider(fake);

    await turn(provider, 'before');
    expect(await turn(provider, 'after')).toEqual(['started-2']);

    expect(methods(fake)).toEqual(['thread/start', 'thread/fork', 'thread/start']);
    expect(fake.requests.at(-2)!.params.baseInstructions).toBe('after');
  });
});
