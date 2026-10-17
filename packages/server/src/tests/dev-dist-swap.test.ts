/**
 * The dev bundler's stage-and-swap into `FRONTEND_DIST`, against a real temp dir.
 *
 * What it guards (issue #183): two dev servers on one checkout shared one staging dir,
 * so one deleted the other's half-built output and the victim swapped in an index.html
 * whose `main-*.js` was gone. The fixes asserted here are the per-pid scratch names, the
 * refusal to swap a stage missing an entry it links, and a swap that survives another
 * process landing its dist mid-swap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asideDirFor,
  assertEntriesStaged,
  removeStaleBuildDirs,
  stagingDirFor,
  swapIntoPlace,
} from '../http/dev-dist-swap.js';

let root: string;
let dist: string;

/** A whole build: an index.html naming its entry, and the entry itself. */
function writeBuild(dir: string, tag: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `main-${tag}.js`), `// ${tag}`);
  writeFileSync(join(dir, 'index.html'), `<script src="/main-${tag}.js"></script>`);
}

const servedTag = () => readFileSync(join(dist, 'index.html'), 'utf8').match(/main-(\w+)\.js/)?.[1];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yaar-dist-swap-'));
  dist = join(root, 'dist');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scratch dir names', () => {
  it('differ per pid, and stay siblings of dist so rename is atomic', () => {
    expect(stagingDirFor(dist, 1)).not.toBe(stagingDirFor(dist, 2));
    expect(asideDirFor(dist, 1)).not.toBe(stagingDirFor(dist, 1));
    expect(stagingDirFor(dist, 1).startsWith(dist)).toBe(true);
    expect(stagingDirFor(dist)).toBe(`${dist}.staging-${process.pid}`);
  });
});

describe('assertEntriesStaged', () => {
  it('passes when every linked entry is present', () => {
    writeBuild(dist, 'aaaaaaaa');
    writeFileSync(join(dist, 'main-aaaaaaaa.css'), '');
    expect(() =>
      assertEntriesStaged(dist, ['/main-aaaaaaaa.js'], ['/main-aaaaaaaa.css']),
    ).not.toThrow();
  });

  it('refuses a stage whose linked JS was deleted out from under it', () => {
    writeBuild(dist, 'aaaaaaaa');
    rmSync(join(dist, 'main-aaaaaaaa.js'));
    expect(() => assertEntriesStaged(dist, ['/main-aaaaaaaa.js'], [])).toThrow(/main-aaaaaaaa\.js/);
  });

  it('refuses a build with no JS entry at all', () => {
    mkdirSync(dist);
    expect(() => assertEntriesStaged(dist, [], [])).toThrow(/no JS entry/);
  });
});

describe('swapIntoPlace', () => {
  it('installs the first build when no dist exists yet', () => {
    const stage = stagingDirFor(dist, 1);
    writeBuild(stage, 'first000');
    swapIntoPlace(stage, dist, asideDirFor(dist, 1));
    expect(servedTag()).toBe('first000');
    expect(existsSync(stage)).toBe(false);
  });

  it('replaces an existing dist and removes the old one', () => {
    writeBuild(dist, 'old00000');
    const stage = stagingDirFor(dist, 1);
    const aside = asideDirFor(dist, 1);
    writeBuild(stage, 'new00000');
    swapIntoPlace(stage, dist, aside);
    expect(servedTag()).toBe('new00000');
    expect(existsSync(join(dist, 'main-old00000.js'))).toBe(false);
    expect(existsSync(aside)).toBe(false);
  });

  it('is not blocked by an aside dir a crashed swap left behind', () => {
    writeBuild(dist, 'old00000');
    const aside = asideDirFor(dist, 1);
    writeBuild(aside, 'crashed0');
    const stage = stagingDirFor(dist, 1);
    writeBuild(stage, 'new00000');
    swapIntoPlace(stage, dist, aside);
    expect(servedTag()).toBe('new00000');
  });

  it('goes round again when another process lands its dist between our two renames', () => {
    writeBuild(dist, 'old00000');
    const ours = stagingDirFor(dist, 1);
    const theirs = stagingDirFor(dist, 2);
    writeBuild(ours, 'ours0000');
    writeBuild(theirs, 'theirs00');

    let raced = false;
    const rename: typeof renameSync = (from, to) => {
      if (!raced && from === ours && to === dist) {
        raced = true;
        renameSync(theirs, dist); // the other process wins the empty slot
      }
      renameSync(from, to);
    };
    swapIntoPlace(ours, dist, asideDirFor(dist, 1), { rename });

    expect(raced).toBe(true);
    expect(servedTag()).toBe('ours0000');
    expect(existsSync(join(dist, 'main-ours0000.js'))).toBe(true);
    expect(existsSync(asideDirFor(dist, 1))).toBe(false);
  });

  it('gives up after its attempts, leaving a whole build in place', () => {
    writeBuild(dist, 'old00000');
    const ours = stagingDirFor(dist, 1);
    writeBuild(ours, 'ours0000');
    let n = 0;
    const rename: typeof renameSync = (from, to) => {
      if (from === ours && to === dist) writeBuild(dist, `them${String(n++).padStart(4, '0')}`);
      renameSync(from, to);
    };
    expect(() =>
      swapIntoPlace(ours, dist, asideDirFor(dist, 1), { attempts: 3, rename }),
    ).toThrow();
    const tag = servedTag()!;
    expect(existsSync(join(dist, `main-${tag}.js`))).toBe(true);
  });
});

describe('removeStaleBuildDirs', () => {
  it("removes a dead pid's scratch dirs and keeps a live one's", () => {
    writeBuild(dist, 'live0000');
    mkdirSync(stagingDirFor(dist, 111));
    mkdirSync(asideDirFor(dist, 111));
    mkdirSync(stagingDirFor(dist, 222));
    mkdirSync(join(root, 'dist.staging')); // legacy name, owner unknown — not ours to judge
    mkdirSync(join(root, 'other.staging-111')); // a different dist's sibling

    const removed = removeStaleBuildDirs(dist, (pid) => pid === 222);

    expect(removed.sort()).toEqual([asideDirFor(dist, 111), stagingDirFor(dist, 111)].sort());
    expect(existsSync(stagingDirFor(dist, 222))).toBe(true);
    expect(existsSync(join(root, 'dist.staging'))).toBe(true);
    expect(existsSync(join(root, 'other.staging-111'))).toBe(true);
    expect(existsSync(dist)).toBe(true);
  });

  it('never removes its own process', () => {
    mkdirSync(stagingDirFor(dist));
    expect(removeStaleBuildDirs(dist, () => false)).toEqual([]);
    expect(existsSync(stagingDirFor(dist))).toBe(true);
  });
});
