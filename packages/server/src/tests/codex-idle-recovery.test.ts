/**
 * Codex idle-recovery — a thread evicted while the agent sat idle must be
 * *resumed*, not silently replaced with a blank one.
 *
 * When the app-server drops an idle thread from memory, the next `turn/start`
 * is refused with `thread not found: <id>`. The provider's recovery path must
 * reload the persisted rollout via `thread/resume` (keeping the conversation
 * history) instead of nulling the thread id and starting fresh via
 * `thread/start` (the old behavior, which discarded all context on idle).
 *
 * Driven through the real `CodexProvider.query()` generator with a fake
 * JSON-RPC client, so the recovery recursion, the resume fallback, and the
 * single-retry guard are all exercised end to end.
 */
import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { CodexProvider } from '../providers/codex/provider.js';
import type { AppServer } from '../providers/codex/app-server.js';
import type { StreamMessage } from '../providers/types.js';
import { JsonRpcError, type JsonRpcWsClient } from '../providers/codex/jsonrpc-ws-client.js';

/** A fake app-server WS client that scripts `turn/start` to fail exactly once. */
class FakeClient extends EventEmitter {
  isConnected = true;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  private turnStarts = 0;

  /** What the first `turn/start` rejects with. */
  constructor(private readonly firstFailure: Error) {
    super();
  }

  async request(method: string, params?: any): Promise<any> {
    this.requests.push({ method, params });
    switch (method) {
      case 'thread/resume':
        // Rollout still on disk → resume returns the thread with its turns.
        return { thread: { id: params.threadId, turns: [{ id: 'past-turn' }] } };
      case 'thread/start':
        return { thread: { id: 'thread-fresh' } };
      case 'turn/start':
        if (this.turnStarts++ === 0) throw this.firstFailure;
        // Second attempt (post-resume): succeeds, then the turn completes.
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

/** A provider holding `thread-idle` on a live connection, as if a turn already ran. */
function seededProvider(fake: FakeClient): CodexProvider {
  const appServer = {
    isRunning: true,
    createConnection: async () => fake,
  } as unknown as AppServer;
  const provider = new CodexProvider(appServer);
  (provider as unknown as { client: JsonRpcWsClient }).client = fake as unknown as JsonRpcWsClient;
  (provider as unknown as { currentSession: unknown }).currentSession = {
    threadId: 'thread-idle',
    systemPrompt: 'sp',
    model: undefined,
    mcpScope: undefined,
  };
  return provider;
}

async function drain(provider: CodexProvider): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  const options = { systemPrompt: 'sp', conversation: { kind: 'new' } } as const;
  for await (const msg of provider.query('continue our chat', options)) messages.push(msg);
  return messages;
}

describe('CodexProvider idle recovery', () => {
  it('resumes the evicted thread instead of starting a blank one', async () => {
    // app-server's own wording for a thread it no longer holds.
    const fake = new FakeClient(
      new JsonRpcError('turn/start', -32600, 'thread not found: thread-idle'),
    );
    const provider = seededProvider(fake);

    const messages = await drain(provider);

    const methods = fake.requests.map((r) => r.method);
    // The evicted thread was resumed by id — history preserved.
    expect(methods).toContain('thread/resume');
    const resume = fake.requests.find((r) => r.method === 'thread/resume');
    expect((resume!.params as { threadId: string }).threadId).toBe('thread-idle');
    // And it never fell back to a brand-new thread.
    expect(methods).not.toContain('thread/start');
    // The recovered session keeps the original thread id, not a fresh one.
    expect(provider.getSessionId()).toBe('thread-idle');
    // The turn ran to completion after recovery.
    expect(messages.some((m) => m.type === 'complete')).toBe(true);
  });

  it('does not take a client-side timeout for a lost thread', async () => {
    // The old test matched `thread` anywhere in any error, and this one names a method.
    const fake = new FakeClient(new Error('Request timed out: turn/start (id=1)'));
    const provider = seededProvider(fake);

    const messages = await drain(provider);

    expect(fake.requests.map((r) => r.method)).not.toContain('thread/resume');
    expect(messages).toEqual([{ type: 'error', error: 'Request timed out: turn/start (id=1)' }]);
  });

  it('surfaces any other refusal with its JSON-RPC code named', async () => {
    const fake = new FakeClient(new JsonRpcError('turn/start', -32602, 'input too large'));
    const provider = seededProvider(fake);

    const messages = await drain(provider);

    expect(fake.requests.map((r) => r.method)).not.toContain('thread/resume');
    expect(messages).toEqual([
      {
        type: 'error',
        error: 'input too large (code: -32602)',
        errorCode: 'jsonrpc_invalid_params',
      },
    ]);
  });
});
