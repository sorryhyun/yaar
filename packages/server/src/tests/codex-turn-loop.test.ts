/**
 * The Codex read loop, now that turn end is decided in one place.
 *
 * The loop used to pull notifications off a hand-rolled queue and decide turn
 * end twice: the mapper by the `StreamMessage` type it produced, the loop by the
 * raw method name. The two had to agree, and on an `error` with `willRetry` they
 * did not — the loop ended a turn the app-server was still retrying (the bug
 * `codex/errors.ts` records). The loop now reads a channel that closes behind the
 * first message the *mapper* typed terminal, so there is no second opinion.
 *
 * Driven through the real `CodexProvider.query()` with a fake JSON-RPC client:
 *
 * 1. A retryable error is a notice mid-stream; the answer after it is read.
 * 2. Nothing after the terminal message is yielded.
 * 3. `steer()` waits for `turn/start` to answer and names that turn's id.
 * 4. `interrupt()` names the turn id and ends the read loop.
 */
import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';

import { CodexProvider } from '../providers/codex/provider.js';
import type { AppServer } from '../providers/codex/app-server.js';
import type { JsonRpcWsClient } from '../providers/codex/jsonrpc-ws-client.js';
import type { StreamMessage } from '../providers/types.js';

class FakeClient extends EventEmitter {
  isConnected = true;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  /** Held open until the test answers, so the pre-start window is observable. */
  private answerTurnStart: ((id: string) => void) | null = null;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === 'turn/start') {
      const id = await new Promise<string>((resolve) => {
        this.answerTurnStart = resolve;
      });
      return { turn: { id } };
    }
    return {};
  }

  startTurn(id: string): void {
    this.answerTurnStart?.(id);
    this.answerTurnStart = null;
  }

  notify(method: string, params: unknown): void {
    this.emit('notification', method, params);
  }

  respond(): void {}
  respondError(): void {}
  close(): void {}
}

function providerWith(fake: FakeClient): CodexProvider {
  const provider = new CodexProvider({
    isRunning: true,
    createConnection: async () => fake,
  } as unknown as AppServer);
  (provider as unknown as { client: JsonRpcWsClient }).client = fake as unknown as JsonRpcWsClient;
  (provider as unknown as { currentSession: unknown }).currentSession = {
    threadId: 'thread-1',
    systemPrompt: 'sp',
    model: undefined,
    mcpScope: undefined,
  };
  return provider;
}

/** Run a query to completion in the background, collecting what it yields. */
function collect(provider: CodexProvider): { messages: StreamMessage[]; done: Promise<void> } {
  const messages: StreamMessage[] = [];
  const done = (async () => {
    for await (const m of provider.query('hi', { systemPrompt: 'sp' })) messages.push(m);
  })();
  return { messages, done };
}

/** Let the query reach `turn/start` (or get past it). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('CodexProvider read loop', () => {
  it('reads past a retryable error to the answer the retry produced', async () => {
    const fake = new FakeClient();
    const { messages, done } = collect(providerWith(fake));
    await settle();
    fake.startTurn('turn-1');
    await settle();

    fake.notify('error', {
      error: { message: 'stream disconnected', codexErrorInfo: 'serverOverloaded' },
      willRetry: true,
    });
    fake.notify('item/agentMessage/delta', { delta: 'the answer' });
    fake.notify('turn/completed', { turn: { status: 'completed' } });
    await done;

    expect(messages.map((m) => m.type)).toEqual(['notice', 'text', 'complete']);
    expect(messages[1].content).toBe('the answer');
  });

  it('yields nothing after the terminal message', async () => {
    const fake = new FakeClient();
    const { messages, done } = collect(providerWith(fake));
    await settle();
    fake.startTurn('turn-1');
    await settle();

    fake.notify('error', { error: { message: 'fatal' }, willRetry: false });
    fake.notify('item/agentMessage/delta', { delta: 'stray' });
    await done;

    expect(messages.map((m) => m.type)).toEqual(['error']);
  });

  it('steers once turn/start answers, naming that turn', async () => {
    const fake = new FakeClient();
    const provider = providerWith(fake);
    const { done } = collect(provider);
    await settle();

    // The agent is running but turn/start has not answered: no id to name yet.
    const steered = provider.steer('also this');
    await settle();
    expect(fake.requests.some((r) => r.method === 'turn/steer')).toBe(false);

    fake.startTurn('turn-7');
    expect(await steered).toBe(true);
    const steer = fake.requests.find((r) => r.method === 'turn/steer');
    expect((steer?.params as { expectedTurnId: string }).expectedTurnId).toBe('turn-7');

    fake.notify('turn/completed', { turn: { status: 'completed' } });
    await done;
    // Idle again: nothing to steer.
    expect(await provider.steer('too late')).toBe(false);
  });

  it('interrupt names the turn and ends the read loop', async () => {
    const fake = new FakeClient();
    const provider = providerWith(fake);
    const { messages, done } = collect(provider);
    await settle();
    fake.startTurn('turn-3');
    await settle();

    const receipt = await provider.interrupt();
    await done;

    expect(receipt.outcome).toBe('acknowledged');
    const interrupt = fake.requests.find((r) => r.method === 'turn/interrupt');
    expect((interrupt?.params as { turnId: string }).turnId).toBe('turn-3');
    expect(messages).toEqual([]);
  });
});
