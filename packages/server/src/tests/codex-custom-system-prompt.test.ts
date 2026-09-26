/**
 * `config/system-prompt.txt` reaches every provider, because `AgentSession` — not the
 * provider — picks the base prompt. It used to be the provider's own `systemPrompt`
 * field, and Codex once took the built-in orchestrator prompt directly, so a custom
 * prompt silently applied to one provider only.
 *
 * The base must also hold still between turns: Codex compares the assembled prompt
 * string and forks its thread whenever it differs.
 */
import { describe, it, expect, mock } from 'bun:test';

mock.module('../agents/load-system-prompt.js', () => ({
  loadCustomSystemPrompt: () => 'CUSTOM PROMPT FROM CONFIG',
}));

const { AgentSession } = await import('../agents/agent-session.js');
import { monitorSource } from '../agents/context.js';
import { monitorRole } from '../agents/roles.js';
import type {
  AITransport,
  ProviderType,
  StreamMessage,
  TransportOptions,
} from '../providers/types.js';
import type { ConnectionId } from '../session/broadcast-center.js';

function recordingProvider(providerType: ProviderType, seen: TransportOptions[]): AITransport {
  return {
    name: providerType,
    providerType,
    async isAvailable() {
      return true;
    },
    async *query(_prompt: string, options: TransportOptions): AsyncIterable<StreamMessage> {
      seen.push(options);
      yield { type: 'complete' };
    },
    async interrupt() {
      return { outcome: 'idle' as const };
    },
    async dispose() {},
  };
}

async function turn(session: InstanceType<typeof AgentSession>, override?: string): Promise<void> {
  await session.handleMessage('hi', {
    role: monitorRole('0'),
    source: monitorSource('0'),
    monitorId: '0',
    ...(override ? { systemPromptOverride: override } : {}),
  });
}

describe('AgentSession base system prompt', () => {
  for (const providerType of ['codex', 'claude'] as const) {
    it(`uses the custom prompt from config on ${providerType}, identically each turn`, async () => {
      const seen: TransportOptions[] = [];
      const session = new AgentSession('conn-prompt' as ConnectionId);
      session.attachProvider(recordingProvider(providerType, seen));

      await turn(session);
      await turn(session);

      expect(seen).toHaveLength(2);
      expect(seen[0].systemPrompt).toStartWith('CUSTOM PROMPT FROM CONFIG');
      expect(seen[1].systemPrompt).toBe(seen[0].systemPrompt);
      await session.cleanup();
    });
  }

  it('lets a profile prompt replace the base', async () => {
    const seen: TransportOptions[] = [];
    const session = new AgentSession('conn-prompt-override' as ConnectionId);
    session.attachProvider(recordingProvider('codex', seen));

    await turn(session, 'PROFILE PROMPT');

    expect(seen[0].systemPrompt).toStartWith('PROFILE PROMPT');
    expect(seen[0].systemPrompt).not.toContain('CUSTOM PROMPT FROM CONFIG');
    await session.cleanup();
  });
});
