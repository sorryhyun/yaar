import { describe, expect, test } from 'bun:test';
import {
  splitStatePath,
  selectStatePath,
  searchValuePaths,
} from '../features/window/state-path.js';

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

describe('searchValuePaths', () => {
  const label = 'yaar://windows/studio-3d/state/scene';

  test('one path: value line per matching leaf, with no JSON punctuation to guess at', () => {
    const text = searchValuePaths(scene, label, 'name: "HandR');
    expect(text).toContain('3 of');
    expect(text).toContain('nodes/palm/name: "HandR Palm"');
    expect(text).toContain('nodes/thumb0/children/seg0/name: "HandR Thumb Seg0"');
  });

  test('every listed path reads back through selectStatePath', () => {
    const lines = searchValuePaths(scene, label, '.').split('\n').slice(1);
    for (const line of lines) {
      const path = line.slice(0, line.indexOf(': '));
      const walked = selectStatePath(scene, 'scene', splitStatePath(`scene/${path}`).path);
      expect(walked.ok).toBe(true);
    }
  });

  test('an element without a unique id is spelled by position', () => {
    const value = { rows: [{ id: 'a' }, { id: 'a' }, { v: 1 }] };
    const text = searchValuePaths(value, 'X', '.');
    expect(text).toContain('rows/__idx/0/id: "a"');
    expect(text).toContain('rows/__idx/2/v: 1');
  });

  test('context is siblings under the same parent, containers summarized', () => {
    const text = searchValuePaths(scene, label, 'Thumb Seg0', 1);
    expect(text).toContain(
      'nodes/thumb0/children/seg0/\n  id: "seg0"\n  name: "HandR Thumb Seg0"\n  geometry: {radius}',
    );
  });

  test('only an addressable label is offered as a read prefix', () => {
    expect(searchValuePaths(scene, label, 'fov', 0, true)).toContain(`read ${label}/{path}`);
    const plain = searchValuePaths(scene, label, 'fov');
    expect(plain).toContain('paths are relative to it');
    expect(plain).not.toContain('{path}');
  });

  test('no match says what was searched, and a bad regex says so', () => {
    expect(searchValuePaths(scene, label, 'nope')).toContain('No matches for /nope/');
    expect(searchValuePaths(scene, label, '(')).toContain('Invalid regex');
  });
});
