/**
 * A protocol schema behind a pointer still has to be readable.
 *
 * The compiler hoists a shape an app repeats into the manifest's `$defs` and leaves
 * `{"$ref": "#/$defs/x"}` at each use. That is lossless only if every server-side
 * reader follows the pointer: a `renderType` that does not answers `any`, which is a
 * signature that says *less* than the one it replaced and looks fine doing it. The
 * other half is the slice — `describe` of one command hands its schema on alone, and
 * a slice carrying a pointer to a table it did not bring is corrupt.
 */
import { describe, expect, test } from 'bun:test';
import {
  renderSignature,
  renderInvokeExample,
  declaredParamNames,
} from '../lib/command-signature.js';
import { defsOf, resolveRef, selfContained } from '../lib/schema-refs.js';

const DEFS = {
  vec3: {
    type: 'object',
    properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
    required: ['x', 'y', 'z'],
  },
  fitMode: { type: 'string', enum: ['contain', 'cover', 'stretch'] },
  slot: {
    type: 'object',
    properties: { uri: { type: 'string' }, at: { $ref: '#/$defs/vec3' } },
    required: ['uri'],
  },
};

describe('a signature reads through $defs', () => {
  test('a hoisted param renders as its declared type, not as `any`', () => {
    const descriptor = {
      description: 'Move a node',
      params: {
        type: 'object',
        properties: { id: { type: 'string' }, to: { $ref: '#/$defs/vec3' } },
        required: ['id', 'to'],
      },
    };
    expect(renderSignature('moveNode', descriptor, DEFS)).toBe('moveNode(id: string, to: object)');
    // Without the table there is nothing to resolve against, and the honest answer
    // is the one this door gave before any of this existed.
    expect(renderSignature('moveNode', descriptor)).toBe('moveNode(id: string, to: any)');
  });

  test('an enum behind a ref still shows its values — the reason enums are special-cased', () => {
    const descriptor = {
      description: 'Fit',
      params: {
        type: 'object',
        properties: { mode: { $ref: '#/$defs/fitMode' } },
        required: ['mode'],
      },
    };
    expect(renderSignature('fit', descriptor, DEFS)).toBe('fit(mode: "contain"|"cover"|"stretch")');
  });

  test('refs inside arrays and unions resolve too', () => {
    const descriptor = {
      description: 'Batch',
      params: {
        type: 'object',
        properties: {
          points: { type: 'array', items: { $ref: '#/$defs/vec3' } },
          mode: { anyOf: [{ $ref: '#/$defs/fitMode' }, { type: 'null' }] },
        },
      },
    };
    expect(renderSignature('batch', descriptor, DEFS)).toBe(
      'batch(points?: object[], mode?: "contain"|"cover"|"stretch"|null)',
    );
  });

  test('the invoke example is rendered from the same resolution', () => {
    const descriptor = {
      description: 'Move',
      params: { type: 'object', properties: { to: { $ref: '#/$defs/vec3' } }, required: ['to'] },
    };
    expect(renderInvokeExample('yaar://windows/w/commands/moveNode', descriptor, DEFS)).toBe(
      'invoke("yaar://windows/w/commands/moveNode", { to: <object> })',
    );
  });

  test('a params that is itself a ref still declares its param names', () => {
    // The dedup pass never hoists a descriptor root — this is for a hand-authored
    // protocol.json that points `params` at a def of its own.
    const descriptor = { description: 'Place', params: { $ref: '#/$defs/vec3' } };
    expect(declaredParamNames(descriptor, DEFS)).toEqual(['x', 'y', 'z']);
    expect(renderSignature('place', descriptor, DEFS)).toBe(
      'place(x: number, y: number, z: number)',
    );
  });

  test('a ref with siblings keeps the siblings', () => {
    const resolved = resolveRef(
      { $ref: '#/$defs/vec3', description: 'Where to put it' },
      DEFS,
    ) as Record<string, unknown>;
    expect(resolved.description).toBe('Where to put it');
    expect(resolved.type).toBe('object');
  });
});

describe('a pointer that goes nowhere is not an exception', () => {
  test('a dangling ref renders as `any` rather than throwing inside a describe', () => {
    const descriptor = {
      description: 'X',
      params: { type: 'object', properties: { a: { $ref: '#/$defs/gone' } } },
    };
    expect(renderSignature('x', descriptor, DEFS)).toBe('x(a?: any)');
  });

  test('a cycle terminates', () => {
    const cyclic = { loop: { $ref: '#/$defs/loop' } };
    expect(() => resolveRef({ $ref: '#/$defs/loop' }, cyclic)).not.toThrow();
  });
});

describe('one command sliced out of a manifest stands alone', () => {
  test('the slice carries the defs it reaches, transitively', () => {
    const schema = { type: 'object', properties: { map: { $ref: '#/$defs/slot' } } };
    const out = selfContained(schema, DEFS) as Record<string, any>;
    // `slot` points at `vec3`, so a slice with only `slot` would still dangle.
    expect(Object.keys(out.$defs)).toEqual(['slot', 'vec3']);
    expect(out.properties.map).toEqual({ $ref: '#/$defs/slot' });
  });

  test('it carries only what it reaches', () => {
    const schema = { type: 'object', properties: { mode: { $ref: '#/$defs/fitMode' } } };
    expect(Object.keys((selfContained(schema, DEFS) as Record<string, any>).$defs)).toEqual([
      'fitMode',
    ]);
  });

  test('a schema that points at nothing is returned untouched', () => {
    // Which is nearly every command, and keeps that answer byte-identical.
    const schema = { type: 'object', properties: { id: { type: 'string' } } };
    expect(selfContained(schema, DEFS)).toBe(schema);
    expect(selfContained(schema, undefined)).toBe(schema);
  });
});

describe('defsOf', () => {
  test('reads the table off a manifest, and answers undefined for one without', () => {
    expect(defsOf({ $defs: DEFS })).toBe(DEFS as unknown as Record<string, unknown>);
    expect(defsOf({ commands: {} })).toBeUndefined();
    expect(defsOf(null)).toBeUndefined();
    expect(defsOf({ $defs: 'nonsense' })).toBeUndefined();
  });
});
