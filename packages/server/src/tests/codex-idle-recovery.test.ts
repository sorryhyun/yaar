/**
 * Codex idle-recovery — a thread evicted while the agent sat idle must be
 * *resumed*, not silently replaced with a blank one.
 *
 * When the app-server drops an idle thread from memory, the next `turn/start`
 * rejects with an "invalid thread" error. The provider's recovery path must
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
import type { JsonRpcWsClient } from '../providers/codex/jsonrpc-ws-client.js';

/** A fake app-server WS client that scripts `turn/start` to fail exactly once. */
class FakeClient extends EventEmitter {
  isConnected = true;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  private turnStarts = 0;

  async request(method: string, params?: any): Promise<any> {
    this.requests.push({ method, params });
    switch (method) {
      case 'thread/resume':
        // Rollout still on disk → resume returns the thread with its turns.
        return { thread: { id: params.threadId, turns: [{ id: 'past-turn' }] } };
      case 'thread/start':
        return { thread: { id: 'thread-fresh' } };
      case 'turn/start':
        if (this.turnStarts++ === 0) {
          // First attempt: the idle thread was evicted from memory.
          throw new Error('invalid thread: not found');
        }
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

describe('CodexProvider idle recovery', () => {
  it('resumes the evicted thread instead of starting a blank one', async () => {
    const fake = new FakeClient();
    const appServer = {
      isRunning: true,
      createConnection: async () => fake,
    } as unknown as AppServer;
    const provider = new CodexProvider(appServer);

    // Seed a live connection and an existing thread, as if a turn already ran.
    (provider as unknown as { client: JsonRpcWsClient }).client =
      fake as unknown as JsonRpcWsClient;
    (provider as unknown as { currentSession: unknown }).currentSession = {
      threadId: 'thread-idle',
      systemPrompt: 'sp',
      model: undefined,
      mcpScope: undefined,
    };

    const messages = [];
    for await (const msg of provider.query('continue our chat', { systemPrompt: 'sp' })) {
      messages.push(msg);
    }

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
});
