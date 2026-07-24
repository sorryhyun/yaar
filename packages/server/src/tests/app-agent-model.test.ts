import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { extractProtocolFromDir } from '@yaar/compiler';
// Import the concrete modules rather than the `profiles/index.js` barrel — the
// barrel is what four other files stub with `mock.module`, and depending on it
// here is what made this file's result depend on the runner's isolation.
import { buildAppAgentProfile } from '../agents/profiles/app-agent.js';
import { claudeModelToCodex } from '../agents/profiles/model-tiers.js';
import { resolveAppDir } from '../features/apps/roots.js';

// `buildAppAgentProfile` reads `appStateKeys` from an app's built
// `dist/protocol.json`. CI builds `@yaar/shared` and `@yaar/compiler` but never
// the apps, so that artifact is absent there and the manifest reads back empty —
// a green local run, a red CI. Regenerate it from source via the same extractor
// the compiler uses at build time (available because CI does build the compiler),
// so the test asserts real behavior in both environments.
async function ensureProtocol(appId: string): Promise<void> {
  const appDir = resolveAppDir(appId);
  if (!appDir) throw new Error(`app "${appId}" not found`);
  const distProtocol = join(appDir, 'dist', 'protocol.json');
  if (await Bun.file(distProtocol).exists()) return;
  const { protocol } = await extractProtocolFromDir(join(appDir, 'src'));
  if (!protocol) throw new Error(`no protocol extracted for "${appId}"`);
  await mkdir(join(appDir, 'dist'), { recursive: true });
  await Bun.write(distProtocol, JSON.stringify(protocol, null, 2));
}

beforeAll(async () => {
  await Promise.all([ensureProtocol('dock'), ensureProtocol('devtools')]);
});

describe('app agent model selection', () => {
  it('defaults apps without agentType to Sonnet/Terra', async () => {
    const profile = await buildAppAgentProfile('dock');

    expect(profile.model).toBe('claude-sonnet-4-6');
    expect(claudeModelToCodex(profile.model)).toBe('gpt-5.6-terra');
    expect(profile.appStateKeys).toEqual(['appearance', 'display', 'nowIso', 'weather']);
  });

  it('preserves an explicit Opus app tier and maps it to Terra', async () => {
    const profile = await buildAppAgentProfile('devtools');

    expect(profile.model).toBe('claude-opus-4-8');
    expect(claudeModelToCodex(profile.model)).toBe('gpt-5.6-terra');
  });
});
