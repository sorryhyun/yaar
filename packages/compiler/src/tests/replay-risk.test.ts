/**
 * A command that sounds one-shot but leaves replay to the default is a warning on the
 * compile result.
 *
 * The default (`'always'`) re-sends every recorded command to an iframe that remounts. An
 * app whose `addNode` persists the node itself gets a second node on every reconnect —
 * one report counted 23 replays, then 48 on the next — and nothing in the build said so.
 * The verdict comes from the command's name, so it never fails the build.
 */
import { beforeAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { listReplayRisks, type AppCommandDescriptor } from '@yaar/shared';
import { initCompiler } from '../config.js';
import { compileTypeScript } from '../compile.js';
import { replayRiskWarning } from '../protocol/replay-risk.js';

// The compile cases pay for a real Bun.build().
setDefaultTimeout(30_000);

const commands = (entries: Record<string, AppCommandDescriptor>) => entries;

describe('listReplayRisks', () => {
  test('names one-shot verbs in camel, snake and kebab case', () => {
    expect(
      listReplayRisks(
        commands({
          addNode: { description: '' },
          delete_graph: { description: '' },
          'remove-clone': { description: '' },
          AcceptProposal: { description: '' },
          publish: { description: '' },
        }),
      ),
    ).toEqual(['addNode', 'delete_graph', 'remove-clone', 'AcceptProposal', 'publish']);
  });

  test('leaves restoring verbs alone, and words that only start like a verb', () => {
    expect(
      listReplayRisks(
        commands({
          setDeck: { description: '' },
          updateMemo: { description: '' },
          navigate: { description: '' },
          address: { description: '' },
          postponed: { description: '' },
          'storage:write': { description: '' },
        }),
      ),
    ).toEqual([]);
  });

  // Either answer is an answer: the warning asks for a decision, not for 'never'.
  test('any declared policy silences it', () => {
    expect(
      listReplayRisks(
        commands({
          addMemo: { description: '', replay: 'never' },
          addFilter: { description: '', replay: 'always' },
        }),
      ),
    ).toEqual([]);
  });
});

describe('replayRiskWarning', () => {
  test('one warning naming every finding, in ASCII', () => {
    const warning = replayRiskWarning({
      commands: { addNode: { description: '' }, deleteGraph: { description: '' } },
    });
    expect(warning).toContain('addNode, deleteGraph declare no `replay` policy');
    expect(warning).toMatch(/^[\x20-\x7e]*$/);
  });

  test('null when nothing is at risk', () => {
    expect(replayRiskWarning({ commands: { setView: { description: '' } } })).toBeNull();
  });
});

describe('compileTypeScript', () => {
  beforeAll(() => {
    initCompiler({ projectRoot: resolve(import.meta.dir, '../../../..'), isBundledExe: false });
  });

  let sandbox: string | null = null;
  afterEach(async () => {
    if (sandbox) await rm(sandbox, { recursive: true, force: true });
    sandbox = null;
  });

  async function compileSource(source: string) {
    sandbox = await mkdtemp(join(tmpdir(), 'yaar-replay-risk-'));
    await mkdir(join(sandbox, 'src'), { recursive: true });
    await Bun.write(join(sandbox, 'src', 'main.ts'), source);
    return compileTypeScript(sandbox, { title: 'Replay Risk', minify: false });
  }

  test('ships the app and warns about the command left to the default', async () => {
    const result = await compileSource(`import { defineApp } from '@bundled/yaar';
export default defineApp({
  id: 'demo',
  name: 'Demo',
  commands: {
    addNode: { description: 'Add a node', run: () => 1 },
    deleteGraph: { description: 'Delete the graph', replay: 'never', run: () => 2 },
    setView: { description: 'Show a view', run: () => 3 },
  },
});
`);
    expect(result.errors ?? []).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain('protocol: addNode declares no `replay` policy');
  });

  // The app-level default reaches every command through the manifest, so the check
  // reads it there and says nothing.
  test("defineApp({ replay: 'never' }) answers it for every command", async () => {
    const result = await compileSource(`import { defineApp } from '@bundled/yaar';
export default defineApp({
  id: 'demo',
  name: 'Demo',
  replay: 'never',
  commands: {
    addNode: { description: 'Add a node', run: () => 1 },
  },
});
`);
    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
  });
});
