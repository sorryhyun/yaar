/**
 * Where an app's agent docs are read from — `agent/prompt.md` and `agent/hint.md`,
 * the `app.json` override, and the root filenames they replaced — plus which docs
 * survive a clone → deploy round trip.
 *
 * Real filesystem because that is the whole subject: `loadAppPrompt`/`loadAppHint` go
 * through `resolveAppDir`, which answers from `existsSync`, so there is nothing to
 * assert against a mock. See this directory's header for why it gets its own process.
 */
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { USER_APPS_DIR } from '../../features/apps/roots.js';
import { loadAppPrompt, loadAppHint } from '../../features/apps/discovery.js';
import { cloneAppSource } from '../../features/dev/clone.js';
import { doDeploy } from '../../features/dev/deploy.js';
import { getStorageDir } from '../../config.js';

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

// A deploy snapshots the app into a shadow git repo beside the storage dir.
const shadowDir = join(getStorageDir(), 'app-git', `${APP_ID}.git`);

afterAll(async () => {
  await rm(appDir, { recursive: true, force: true });
  await rm(shadowDir, { recursive: true, force: true });
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
  // copies and we cannot migrate them, so `HINT.md` keeps working — and says so.
  it('still reads the legacy root HINT.md, and warns which path to move to', async () => {
    await seed({
      'app.json': '{"name":"Fixture"}\n',
      'HINT.md': 'legacy hint\n',
    });

    const [hint, warnings] = await capturingWarnings(() => loadAppHint(APP_ID));
    expect(hint).toBe('legacy hint\n');
    expect(warnings.join('\n')).toContain('agent/hint.md');
  });

  // `AGENTS.md` is the one legacy name that could not stay readable. It is the coding
  // agent's doc now, carried by clone and deploy like any other source file, so reading
  // it here would install an app's architecture notes as that app's runtime persona.
  it('does not read a root AGENTS.md as the prompt, and says which reading it took', async () => {
    await seed({
      'app.json': '{"name":"Fixture"}\n',
      'AGENTS.md': 'how to edit this app\n',
    });

    const [prompt, warnings] = await capturingWarnings(() => loadAppPrompt(APP_ID));
    expect(prompt).toBeNull();
    // The notice has to name both readings — most apps with this file meant the
    // coding-agent one and have nothing to do.
    expect(warnings.join('\n')).toContain('AGENTS.md');
    expect(warnings.join('\n')).toContain('agent/prompt.md');
  });

  it('prefers agent/ over the retired name, and does not warn about a file it ignored', async () => {
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

/**
 * The docs have to make the round trip devtools actually performs: clone an app into a
 * project, edit, deploy. Deploy copies a *named* set out of the sandbox — `dist/`,
 * `src/`, components, `app.json`, the agent docs — so a doc missing from that list is
 * written to the project, deployed, and gone, with the deploy reporting success.
 * `AGENTS.md` was missing from it, which is the whole reason an app could not keep one.
 */
describe('agent docs across clone and deploy', () => {
  const AGENTS_MD = '# AGENTS.md\n\nHow to edit this app.\n';
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'yaar-agent-docs-'));
    await rm(shadowDir, { recursive: true, force: true });
  });

  it('carries AGENTS.md and the agent docs from a sandbox into the installed app', async () => {
    await seed({ 'app.json': `{"name":"Fixture"}\n` });
    // A sandbox whose manifest is already extracted deploys without compiling anything.
    await mkdir(join(sandbox, 'dist'), { recursive: true });
    await writeFile(join(sandbox, 'dist', 'index.html'), '<html></html>');
    await writeFile(join(sandbox, 'dist', 'protocol.json'), '{"state":{},"commands":{}}');
    await writeFile(join(sandbox, 'app.json'), '{"name":"Fixture","createShortcut":false}\n');
    await writeFile(join(sandbox, 'AGENTS.md'), AGENTS_MD);
    await mkdir(join(sandbox, 'agent'), { recursive: true });
    await writeFile(join(sandbox, 'agent', 'prompt.md'), 'runtime prompt\n');

    const result = await doDeploy('unused-sandbox-id', { appId: APP_ID, sourcePath: sandbox });
    expect(result.success).toBe(true);

    expect(await Bun.file(join(appDir, 'AGENTS.md')).text()).toBe(AGENTS_MD);
    // And it is still only the coding doc — carrying it must not make it a prompt.
    expect(await loadAppPrompt(APP_ID)).toBe('runtime prompt\n');
  });

  it('clones AGENTS.md back out, so the agent editing the app can read it', async () => {
    await seed({
      'app.json': '{"name":"Fixture"}\n',
      'src/main.ts': 'export const x = 1;\n',
      'AGENTS.md': AGENTS_MD,
      'agent/prompt.md': 'runtime prompt\n',
    });

    const clone = await cloneAppSource(APP_ID);
    expect(clone.success).toBe(true);
    const paths = clone.files?.map((f) => f.path) ?? [];
    expect(paths).toContain('AGENTS.md');
    expect(paths).toContain('agent/prompt.md');
    expect(clone.files?.find((f) => f.path === 'AGENTS.md')?.content).toBe(AGENTS_MD);
  });

  afterAll(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });
});
