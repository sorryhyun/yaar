/**
 * Path containment: the escapes it must catch, and the legitimate name (`a..b`) a naive
 * substring check on `..` would wrongly reject.
 */
import { describe, it, expect } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containedPath, containedRealPath, isContained, isPathWithin } from '../paths.js';

describe('containedPath', () => {
  const base = '/base';

  it('resolves a plain relative path under base', () => {
    expect(containedPath(base, 'a/b.txt')).toBe('/base/a/b.txt');
  });

  it('rejects a `..` escape', () => {
    expect(containedPath(base, '../etc/passwd')).toBeNull();
    expect(containedPath(base, 'a/../../etc/passwd')).toBeNull();
  });

  it('rejects a bare `..`', () => {
    expect(containedPath(base, '..')).toBeNull();
  });

  it('accepts a name that merely contains `..` without climbing out', () => {
    // A substring check on the relative path (`.includes('..')`) would wrongly reject this.
    expect(containedPath(base, 'a..b')).toBe('/base/a..b');
    expect(containedPath(base, 'sub/a..b/file.txt')).toBe('/base/sub/a..b/file.txt');
  });

  it('accepts base itself', () => {
    expect(containedPath(base, '')).toBe('/base');
    expect(containedPath(base, '.')).toBe('/base');
  });

  it('rejects a sibling directory that merely shares a prefix', () => {
    // relative('/base', '/base-evil') is '../base-evil', not something under /base.
    expect(containedPath(base, '../base-evil')).toBeNull();
  });

  it('joins an absolute-looking target under base rather than treating it as a root override', () => {
    // path.join, unlike path.resolve, never lets a later absolute segment replace the base —
    // so this is a subpath of /base, not an escape to /etc.
    expect(containedPath(base, '/etc/passwd')).toBe('/base/etc/passwd');
  });
});

describe('isContained', () => {
  it('mirrors containedPath as a boolean', () => {
    expect(isContained('/base', 'a/b.txt')).toBe(true);
    expect(isContained('/base', '../etc/passwd')).toBe(false);
  });
});

describe('isPathWithin', () => {
  it('checks an already-absolute candidate without joining', () => {
    expect(isPathWithin('/base', '/base/sub')).toBe(true);
    expect(isPathWithin('/base', '/base')).toBe(true);
    expect(isPathWithin('/base', '/etc/passwd')).toBe(false);
  });

  it('rejects a sibling that shares a string prefix but not a path prefix', () => {
    expect(isPathWithin('/base', '/base-evil')).toBe(false);
  });
});

describe('containedRealPath', () => {
  let dir: string;

  it('resolves an existing file the same as containedPath', async () => {
    dir = await mkdtemp(join(tmpdir(), 'yaar-paths-'));
    try {
      await writeFile(join(dir, 'file.txt'), 'x');
      expect(await containedRealPath(dir, 'file.txt')).toBe(join(dir, 'file.txt'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the sync result when the target does not exist yet', async () => {
    dir = await mkdtemp(join(tmpdir(), 'yaar-paths-'));
    try {
      const target = join(dir, 'not-yet.txt');
      expect(await containedRealPath(dir, 'not-yet.txt')).toBe(target);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a `..` escape before ever touching the filesystem', async () => {
    expect(await containedRealPath('/base', '../etc/passwd')).toBeNull();
  });

  it('catches a symlink inside base that points outside it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'yaar-paths-'));
    const outside = await mkdtemp(join(tmpdir(), 'yaar-paths-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'x');
      await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'));
      expect(await containedRealPath(dir, 'link.txt')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
