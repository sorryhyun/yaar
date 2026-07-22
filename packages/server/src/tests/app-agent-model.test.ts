import { describe, expect, it } from 'bun:test';
// Import the concrete modules rather than the `profiles/index.js` barrel — the
// barrel is what four other files stub with `mock.module`, and depending on it
// here is what made this file's result depend on the runner's isolation.
import { buildAppAgentProfile } from '../agents/profiles/app-agent.js';
import { claudeModelToCodex } from '../agents/profiles/model-tiers.js';

describe('app agent model selection', () => {
  it('defaults apps without agentType to Sonnet/Terra', async () => {
    const profile = await buildAppAgentProfile('dock');

    expect(profile.model).toBe('claude-sonnet-4-6');
    expect(claudeModelToCodex(profile.model)).toBe('gpt-5.6-terra');
  });

  it('preserves an explicit Opus app tier and maps it to Terra', async () => {
    const profile = await buildAppAgentProfile('devtools');

    expect(profile.model).toBe('claude-opus-4-8');
    expect(claudeModelToCodex(profile.model)).toBe('gpt-5.6-terra');
  });
});
