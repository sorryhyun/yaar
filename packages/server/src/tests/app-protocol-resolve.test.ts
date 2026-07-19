/**
 * The server-side half of an app-protocol round trip: a request goes out, the frontend answers,
 * and the pending entry must settle with that answer.
 *
 * Reproduces the observed failure — the browser demonstrably sends
 * `APP_PROTOCOL_RESPONSE` with a valid manifest, and the agent is still told the app timed out.
 */
import { describe, it, expect } from 'bun:test';
import { actionEmitter } from '../session/action-emitter.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import type { SessionId } from '../session/types.js';
import type { AppProtocolResponse } from '@yaar/shared';

describe('an app protocol response settles its pending request', () => {
  it('resolves the waiting request with the manifest the app returned', async () => {
    // Capture the requestId the emitter mints, exactly as the frontend would off the wire.
    const seen: { requestId: string }[] = [];
    const listener = (data: { requestId: string }) => seen.push(data);
    actionEmitter.on('app-protocol', listener);

    // In a session, because the request now names the frontend it is asking. "0/ai-chat"
    // is a place on a desktop and every session has one, so without the session the
    // request has no addressee — see `AppProtocolRequestData`.
    const pending = runWithAgentContext(
      { agentId: 'agent-manifest', sessionId: 'sess-manifest' as SessionId },
      () => actionEmitter.emitAppProtocolRequest('0/ai-chat', { kind: 'manifest' }, 5_000),
    );

    // Let the emit land.
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.length).toBe(1);
    const requestId = seen[0].requestId;

    const response: AppProtocolResponse = {
      kind: 'manifest',
      manifest: { appId: 'ai-chat', name: 'AI Chat' },
    } as AppProtocolResponse;

    const resolved = actionEmitter.resolveAppProtocolResponse(requestId, response);
    actionEmitter.off('app-protocol', listener);

    // This is what the live system fails to do.
    expect(resolved).toBe(true);

    const outcome = await pending;
    expect(outcome.ok).toBe(true);
  });
});
