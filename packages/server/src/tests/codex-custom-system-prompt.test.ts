/**
 * Codex honours `config/system-prompt.txt` the way Claude does. It used to take the
 * built-in orchestrator prompt directly, so a custom prompt silently applied to one
 * provider only.
 */
import { describe, it, expect, mock } from 'bun:test';

mock.module('../providers/load-system-prompt.js', () => ({
  loadCustomSystemPrompt: () => 'CUSTOM PROMPT FROM CONFIG',
}));

const { CodexProvider } = await import('../providers/codex/provider.js');
import type { AppServer } from '../providers/codex/app-server.js';

describe('CodexProvider system prompt', () => {
  it('uses the custom prompt from config and keeps it stable across instances', () => {
    const a = new CodexProvider({} as AppServer);
    const b = new CodexProvider({} as AppServer);
    expect(a.systemPrompt).toBe('CUSTOM PROMPT FROM CONFIG');
    // `needsNewThread` compares this string per turn; it must not drift.
    expect(b.systemPrompt).toBe(a.systemPrompt);
  });
});
