/**
 * Where an app's agent docs are read from — `agent/prompt.md` and `agent/hint.md`,
 * the `app.json` override, and the legacy root filenames they replaced.
 *
 * Real filesystem because that is the whole subject: `loadAppPrompt`/`loadAppHint` go
 * through `resolveAppDir`, which answers from `existsSync`, so there is nothing to
 * assert against a mock. See this directory's header for why it gets its own process.
 */
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { USER_APPS_DIR } from '../../features/apps/roots.js';
import { loadAppPrompt, loadAppHint } from '../../features/apps/discovery.js';

// `user-apps/` is git-ignored, so a fixture here cannot dirty the working tree.
const APP_ID = 'agent-docs-fixture';
const appDir = join(USER_APPS_DIR, APP_ID);

async function seed(files: Record<string, string>): Promise<void> {
  await rm(appDir, { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(appDir, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
}

/** Run `fn` with `console.warn` captured, so a deprecation notice can be asserted on. */
async function capturingWarnings<T>(fn: () => Promise<T>): Promise<[T, string[]]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
  try {
    return [await fn(), warnings];
  } finally {
    console.warn = original;
  }
}

afterAll(async () => {
  await rm(appDir, { recursive: true, force: true });
});

describe('app agent docs', () => {
  beforeEach(async () => {
    await seed({ 'app.json': '{"name":"Fixture"}\n' });
  });

  it('reads the prompt and hint from agent/', async () => {
    await seed({
      'app.json': '{"name":"Fixture"}\n',
      'agent/prompt.md': 'I am the prompt.\n',
      'agent/hint.md': 'Route memos here.\n',
    });

    expect(await loadAppPrompt(APP_ID)).toBe('I am the prompt.\n');
    expect(await loadAppHint(APP_ID)).toBe('Route memos here.\n');
  });

  it('is null when the app ships neither — the common case, not an error', async () => {
    expect(await loadAppPrompt(APP_ID)).toBeNull();
    expect(await loadAppHint(APP_ID)).toBeNull();
  });

  it('is null for an app that does not exist', async () => {
    expect(await loadAppPrompt('no-such-app')).toBeNull();
    expect(await loadAppHint('no-such-app')).toBeNull();
  });

  // The `personas` → `subagents` rename is the precedent: dropping a path that a
  // published app still ships makes it silently inert. Market apps carry their own
  // copies and we cannot migrate them, so the old names keep working — and say so.
  it('still reads the legacy root filenames, and warns which path to move to', async () => {
    await seed({
      'app.json': '{"name":"Fixture"}\n',
      'AGENTS.md': 'legacy prompt\n',
      'HINT.md': 'legacy hint\n',
    });

    const [prompt, promptWarnings] = await capturingWarnings(() => loadAppPrompt(APP_ID));
    expect(prompt).toBe('legacy prompt\n');
    expect(promptWarnings.join('\n')).toContain('agent/prompt.md');

    const [hint, hintWarnings] = await capturingWarnings(() => loadAppHint(APP_ID));
    expect(hint).toBe('legacy hint\n');
    expect(hintWarnings.join('\n')).toContain('agent/hint.md');
  });

  it('prefers agent/ over the legacy name, and does not warn about a file it ignored', async () => {
    await seed({
      'app.json': '{"name":"Fixture"}\n',
      'agent/prompt.md': 'new prompt\n',
      'AGENTS.md': 'how to edit this app\n',
    });

    const [prompt, warnings] = await capturingWarnings(() => loadAppPrompt(APP_ID));
    expect(prompt).toBe('new prompt\n');
    expect(warnings).toEqual([]);
  });

  it('honors an app.json path override', async () => {
    await seed({
      'app.json': '{"name":"Fixture","agent":{"prompt":"docs/persona.md","hint":"docs/when.md"}}\n',
      'docs/persona.md': 'overridden prompt\n',
      'docs/when.md': 'overridden hint\n',
      'agent/prompt.md': 'ignored\n',
    });

    expect(await loadAppPrompt(APP_ID)).toBe('overridden prompt\n');
    expect(await loadAppHint(APP_ID)).toBe('overridden hint\n');
  });

  // An app.json is writable by any app holding `yaar-dev`, so the override is a path
  // an app can choose for itself — it may not choose one outside its own directory.
  it('ignores an escaping override rather than following it', async () => {
    await seed({
      'app.json': '{"name":"Fixture","agent":{"prompt":"../../CLAUDE.md"}}\n',
      'agent/prompt.md': 'the real prompt\n',
    });

    expect(await loadAppPrompt(APP_ID)).toBe('the real prompt\n');
  });
});
