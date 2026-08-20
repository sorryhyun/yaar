import { describe, expect, it } from 'bun:test';
// Import the concrete modules rather than the `profiles/index.js` barrel — the
// barrel is what four other files stub with `mock.module`, and depending on it
// here is what made this file's result depend on the runner's isolation.
//
// `appStateKeys` is read from the app's built `dist/protocol.json`, which CI
// never produces (it builds shared + compiler, not the apps). The
// `materialize-app-protocols` preload (bunfig.toml `[test] preload`) regenerates
// it from source before any test file loads — early enough to beat the TTL cache
// in `listApps()`, which a per-file `beforeAll` here could not (another file in
// the shared --parallel process may cache the empty manifest first).
import { buildAppAgentProfile } from '../agents/profiles/app-agent/index.js';
import { claudeModelToCodex } from '../agents/profiles/model-tiers.js';

describe('app agent model selection', () => {
  it('defaults apps without agentType to Sonnet/Terra', async () => {
    const profile = await buildAppAgentProfile('dock');

    expect(profile.model).toBe('claude-sonnet-5');
    expect(claudeModelToCodex(profile.model)).toBe('gpt-5.6-terra');
    expect(profile.appStateKeys).toEqual(['appearance', 'display', 'nowIso', 'weather']);
  });

  it('preserves an explicit Opus app tier and maps it to Terra', async () => {
    const profile = await buildAppAgentProfile('devtools');

    expect(profile.model).toBe('claude-opus-5');
    expect(claudeModelToCodex(profile.model)).toBe('gpt-5.6-sol');
  });
});
