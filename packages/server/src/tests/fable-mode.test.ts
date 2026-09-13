import { afterEach, describe, expect, it } from 'bun:test';
// Concrete modules, not the `profiles/index.js` barrel other files stub with `mock.module`.
import {
  AGENT_TYPE_MODELS,
  FABLE_MODEL,
  resolveAgentModel,
} from '../agents/profiles/model-tiers.js';
import { getMonitorTurnOptions } from '../agents/profiles/turn-options.js';
import { buildSubAgentProfile } from '../agents/profiles/sub-agent.js';

const spec = { appId: 'memo', subId: 'critic', systemPrompt: 'be terse' };

afterEach(() => {
  delete process.env.FABLE;
});

describe('fable mode off', () => {
  it('keeps the usual tiers', () => {
    expect(getMonitorTurnOptions('claude').model).toBe(AGENT_TYPE_MODELS.opus);
    expect(resolveAgentModel()).toBe(AGENT_TYPE_MODELS.sonnet);
    expect(resolveAgentModel('haiku')).toBe(AGENT_TYPE_MODELS.haiku);
    expect(buildSubAgentProfile(spec).model).toBeUndefined();
    expect(buildSubAgentProfile({ ...spec, model: 'claude-haiku-4-5' }).model).toBe(
      'claude-haiku-4-5',
    );
  });
});

describe('fable mode on (FABLE=1)', () => {
  it('runs the monitor agent on Fable', () => {
    process.env.FABLE = '1';
    expect(getMonitorTurnOptions('claude').model).toBe(FABLE_MODEL);
    expect(getMonitorTurnOptions('codex').model).toBe('gpt-5.6-sol');
  });

  it('pins every agent below the monitor to Opus', () => {
    process.env.FABLE = '1';
    expect(resolveAgentModel()).toBe(AGENT_TYPE_MODELS.opus);
    expect(resolveAgentModel('haiku')).toBe(AGENT_TYPE_MODELS.opus);
    expect(buildSubAgentProfile(spec).model).toBe(AGENT_TYPE_MODELS.opus);
    expect(buildSubAgentProfile({ ...spec, model: 'claude-haiku-4-5' }).model).toBe(
      AGENT_TYPE_MODELS.opus,
    );
  });

  it('only turns on for exactly "1"', () => {
    process.env.FABLE = 'true';
    expect(getMonitorTurnOptions('claude').model).toBe(AGENT_TYPE_MODELS.opus);
  });
});
