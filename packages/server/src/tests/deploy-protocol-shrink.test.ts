/**
 * A deploy refuses to shrink an installed app's command manifest by accident.
 *
 * The protocol extractor is best-effort: a spread or computed key stops it, and
 * the manifest silently loses every command after that point. Deploying it would
 * overwrite the installed protocol.json with the truncated one — the agent loses
 * commands it had yesterday, with every other signal green (one real incident:
 * 29 commands to 3). The gate compares against what is installed and refuses to
 * drop commands unless the caller passes `allowProtocolShrink`.
 *
 * Each case is engineered to stop at "Nothing to deploy" once the gate clears,
 * so nothing is ever written to apps/ or user-apps/ beyond the fixture.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { doDeploy, type DeployRefusal } from '../features/dev/deploy.js';
import { USER_APPS_DIR } from '../features/apps/roots.js';

const APP_ID = 'zz-shrink-gate-test';

let sandbox: string;
const installedDir = join(USER_APPS_DIR, APP_ID);

/** Write a sandbox whose only deploy artifact is an already-extracted manifest. */
async function writeSandboxProtocol(commands: string[], state: string[] = []): Promise<void> {
  await mkdir(join(sandbox, 'dist'), { recursive: true });
  await writeFile(
    join(sandbox, 'dist', 'protocol.json'),
    JSON.stringify({
      state: Object.fromEntries(state.map((k) => [k, { description: k }])),
      commands: Object.fromEntries(commands.map((k) => [k, { description: k }])),
    }),
  );
}

/** Simulate an app already installed with the given command manifest. */
async function writeInstalledProtocol(commands: string[], state: string[] = []): Promise<void> {
  await mkdir(join(installedDir, 'dist'), { recursive: true });
  await writeFile(
    join(installedDir, 'dist', 'protocol.json'),
    JSON.stringify({
      state: Object.fromEntries(state.map((k) => [k, { description: k }])),
      commands: Object.fromEntries(commands.map((k) => [k, { description: k }])),
    }),
  );
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'yaar-shrink-gate-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
  await rm(installedDir, { recursive: true, force: true });
});

describe('deploy protocol shrink gate', () => {
  it('refuses when the new manifest drops installed commands', async () => {
    await writeInstalledProtocol(['a', 'b', 'c', 'd']);
    await writeSandboxProtocol(['a']);

    const result = await doDeploy(APP_ID, { appId: APP_ID, sourcePath: sandbox });

    expect(result.success).toBe(false);
    const refusal = result as DeployRefusal;
    expect(refusal.error).toContain('4 to 1 commands');
    expect(refusal.error).toContain('b, c, d');
    expect(refusal.error).toContain('allowProtocolShrink');
    expect(refusal.protocolShrink).toEqual({ before: 4, after: 1, missing: ['b', 'c', 'd'] });
  });

  it('names dropped state keys too, but only commands trigger the gate', async () => {
    await writeInstalledProtocol(['a', 'b'], ['s1', 's2']);
    await writeSandboxProtocol(['a'], ['s1']);

    const result = await doDeploy(APP_ID, { appId: APP_ID, sourcePath: sandbox });

    expect(result.success).toBe(false);
    expect((result as DeployRefusal).error).toContain('state keys: s2');
  });

  it('does not fire when only state keys shrink (commands intact)', async () => {
    await writeInstalledProtocol(['a', 'b'], ['s1', 's2']);
    await writeSandboxProtocol(['a', 'b'], ['s1']);

    const result = await doDeploy(APP_ID, { appId: APP_ID, sourcePath: sandbox });

    // Gate clears; deploy then stops at the harmless "nothing to deploy" door.
    expect(result.success).toBe(false);
    const error = (result as DeployRefusal).error;
    expect(error).not.toContain('shrinks');
    expect(error).toContain('Nothing to deploy');
  });

  it('passes the gate when allowProtocolShrink is set on purpose', async () => {
    await writeInstalledProtocol(['a', 'b', 'c', 'd']);
    await writeSandboxProtocol(['a']);

    const result = await doDeploy(APP_ID, {
      appId: APP_ID,
      sourcePath: sandbox,
      allowProtocolShrink: true,
    });

    // The gate no longer stops it — it clears to "nothing to deploy" instead.
    expect(result.success).toBe(false);
    const error = (result as DeployRefusal).error;
    expect(error).not.toContain('shrinks');
    expect((result as DeployRefusal).protocolShrink).toBeUndefined();
  });

  it('exempts a first deploy — no installed manifest to compare against', async () => {
    // No installedDir written.
    await writeSandboxProtocol(['a']);

    const result = await doDeploy(APP_ID, { appId: APP_ID, sourcePath: sandbox });

    expect(result.success).toBe(false);
    const error = (result as DeployRefusal).error;
    expect(error).not.toContain('shrinks');
    expect(error).toContain('Nothing to deploy');
  });
});
