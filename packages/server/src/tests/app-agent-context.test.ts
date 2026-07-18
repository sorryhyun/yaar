import { describe, expect, it } from 'bun:test';
import { assembleSystemPromptForRole, type SystemPromptLoaders } from '../agents/system-prompt.js';

function contextLoaders(calls: string[]): SystemPromptLoaders {
  return {
    async buildEnvironment() {
      calls.push('environment');
      return '\n\n## Environment\n- Installed apps: OTHER APP HINT';
    },
    async loadMemory() {
      calls.push('memory');
      return '\n\n## Memory\nGLOBAL MEMORY';
    },
  };
}

describe('role-aware system prompt context', () => {
  it('keeps app agents closed over their app-specific profile', async () => {
    const calls: string[] = [];
    const prompt = await assembleSystemPromptForRole(
      'OWN APP DOCS',
      'app-memo-m0-message-1',
      'codex',
      '0',
      contextLoaders(calls),
    );

    expect(prompt).toBe('OWN APP DOCS');
    expect(prompt).not.toContain('OTHER APP HINT');
    expect(prompt).not.toContain('GLOBAL MEMORY');
    expect(calls).toEqual([]);
  });

  it('retains global environment and memory for monitor agents', async () => {
    const calls: string[] = [];
    const prompt = await assembleSystemPromptForRole(
      'MONITOR PROFILE',
      'monitor-message-1',
      'codex',
      '0',
      contextLoaders(calls),
    );

    expect(prompt).toContain('You are the **monitor agent** for `0`');
    expect(prompt).toContain('OTHER APP HINT');
    expect(prompt).toContain('GLOBAL MEMORY');
    expect(calls.sort()).toEqual(['environment', 'memory']);
  });
});
