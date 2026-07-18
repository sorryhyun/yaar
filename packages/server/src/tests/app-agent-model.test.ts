import { describe, expect, it } from 'bun:test';
import { buildAppAgentProfile, claudeModelToCodex } from '../agents/profiles/index.js';

describe('app agent model selection', () => {
  it('defaults apps without agentType to Sonnet/Terra', async () => {
    const profile = await buildAppAgentProfile('dock');

    expect(profile.model).toBe('claude-sonnet-4-6');
    expect(claudeModelToCodex(profile.model)).toBe('gpt-5.6-terra');
  });

  it('preserves an explicit Opus/Sol app tier', async () => {
    const profile = await buildAppAgentProfile('devtools');

    expect(profile.model).toBe('claude-opus-4-8');
    expect(claudeModelToCodex(profile.model)).toBe('gpt-5.6-sol');
  });
});
