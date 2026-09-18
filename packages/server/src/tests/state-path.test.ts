import { describe, expect, test } from 'bun:test';
import { splitStatePath, selectStatePath } from '../features/window/state-path.js';

const scene = {
  nodes: [
    { id: 'palm', name: 'HandR Palm', geometry: { width: 0.07 }, children: [] },
    {
      id: 'thumb0',
      name: 'HandR Thumb J0',
      children: [{ id: 'seg0', name: 'HandR Thumb Seg0', geometry: { radius: 0.009 } }],
    },
  ],
  camera: { fov: 50 },
};

describe('splitStatePath', () => {
  test('the first segment is the key the app is asked for', () => {
    expect(splitStatePath('scene')).toEqual({ key: 'scene', path: [] });
    expect(splitStatePath('scene/nodes/0/geometry')).toEqual({
      key: 'scene',
      path: ['nodes', '0', 'geometry'],
    });
  });

  test('empty segments are dropped and escapes decoded', () => {
    expect(splitStatePath('scene//nodes/').path).toEqual(['nodes']);
    expect(splitStatePath('scene/HandR%20Palm').path).toEqual(['HandR Palm']);
  });
});

describe('selectStatePath', () => {
  test('walks object keys, __idx positions, and element ids', () => {
    expect(selectStatePath(scene, 'scene', ['camera', 'fov'])).toEqual({ ok: true, value: 50 });
    expect(selectStatePath(scene, 'scene', ['nodes', '__idx', '0', 'geometry'])).toEqual({
      ok: true,
      value: { width: 0.07 },
    });
    expect(
      selectStatePath(scene, 'scene', ['nodes', 'thumb0', 'children', 'seg0', 'geometry']),
    ).toEqual({ ok: true, value: { radius: 0.009 } });
  });

  test('a bare number is an id, never a position', () => {
    const rows = [{ id: '7' }, { id: '12', title: 'twelve' }];
    expect(selectStatePath({ rows }, 'db', ['rows', '12', 'title'])).toEqual({
      ok: true,
      value: 'twelve',
    });
    expect(selectStatePath({ rows }, 'db', ['rows', '0']).ok).toBe(false);
    expect(selectStatePath({ rows }, 'db', ['rows', '__idx', '0'])).toEqual({
      ok: true,
      value: { id: '7' },
    });
  });

  test('__idx refuses a non-array and a missing or out-of-range position', () => {
    const notArray = selectStatePath(scene, 'scene', ['camera', '__idx', '0']);
    expect(!notArray.ok && notArray.message).toContain('is not an array');
    const dangling = selectStatePath(scene, 'scene', ['nodes', '__idx']);
    expect(!dangling.ok && dangling.message).toContain('has no "__idx/"');
    const past = selectStatePath(scene, 'scene', ['nodes', '__idx', '5']);
    expect(!past.ok && past.message).toContain('__idx/{0-1}');
  });

  test('a miss names where it stopped and what was there', () => {
    const miss = selectStatePath(scene, 'scene', ['nodes', 'nope']);
    expect(miss.ok).toBe(false);
    if (miss.ok) return;
    expect(miss.message).toContain('state/scene/nodes has no "nope"');
    expect(miss.message).toContain('by id: palm, thumb0');

    const keys = selectStatePath(scene, 'scene', ['camera', 'zoom']);
    expect(!keys.ok && keys.message).toContain('Its keys: fov');

    const leaf = selectStatePath(scene, 'scene', ['camera', 'fov', 'x']);
    expect(!leaf.ok && leaf.message).toContain('number, which has no parts');
  });
});
