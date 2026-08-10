/**
 * The `$defs` fold is content-neutral, or it is a bug.
 *
 * Every case below is one of two claims: *nothing changed* (resolve every `$ref`
 * back and the bytes are the input's, property order included) or *this specific
 * thing must not be touched* (a descriptor's top-level schema, a shape too small to
 * pay for a pointer). A pass that shrinks a manifest by dropping something an agent
 * needed would still look like a win in the byte count, which is why the round trip
 * is the assertion and the size is only ever a sanity check.
 */
import { describe, expect, test } from 'bun:test';
import {
  dedupeProtocolSchemas,
  resolveSchemaRefs,
  type DedupableProtocol,
} from '../protocol/dedupe-schemas.js';

/** A shape big enough to clear the hoist threshold, the way a real one is. */
const TEXTURE_SLOT = {
  type: 'object',
  properties: {
    uri: { type: 'string', description: 'Texture URI or data URL' },
    repeat: { type: 'array', items: { type: 'number' }, description: 'Tiling factor' },
    offset: { type: 'array', items: { type: 'number' }, description: 'UV offset' },
    rotation: { type: 'number', description: 'Radians' },
  },
  required: ['uri'],
};

const VEC3 = {
  type: 'object',
  properties: {
    x: { type: 'number', description: 'X in world units' },
    y: { type: 'number', description: 'Y in world units' },
    z: { type: 'number', description: 'Z in world units' },
  },
  required: ['x', 'y', 'z'],
};

/** Every schema in a protocol, with all refs resolved — the pass's contract as a value. */
function resolvedSchemas(protocol: DedupableProtocol): unknown {
  const defs = (protocol.$defs ?? {}) as Record<string, object>;
  const out: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(protocol.state ?? {})) {
    if (descriptor.schema) out[`state.${key}.schema`] = resolveSchemaRefs(descriptor.schema, defs);
  }
  for (const [key, descriptor] of Object.entries(protocol.commands ?? {})) {
    for (const prop of ['params', 'returns'] as const) {
      const value = descriptor[prop];
      if (value) out[`commands.${key}.${prop}`] = resolveSchemaRefs(value, defs);
    }
  }
  return out;
}

/** Byte-for-byte, so a reordered property is a failure and not a rounding difference. */
function expectLossless(input: DedupableProtocol, output: DedupableProtocol): void {
  expect(JSON.stringify(resolvedSchemas(output))).toBe(JSON.stringify(resolvedSchemas(input)));
}

/** Every `#/$defs/...` a protocol mentions, wherever it mentions it. */
function refNames(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) refNames(item, into);
    return into;
  }
  if (typeof value !== 'object' || value === null) return into;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string' && child.startsWith('#/$defs/')) {
      into.add(child.slice('#/$defs/'.length));
    } else {
      refNames(child, into);
    }
  }
  return into;
}

function expectNoDanglingRefs(protocol: DedupableProtocol): void {
  const declared = new Set(Object.keys(protocol.$defs ?? {}));
  for (const name of refNames({ ...protocol, $defs: undefined })) {
    expect(declared).toContain(name);
  }
  for (const value of Object.values(protocol.$defs ?? {})) {
    for (const name of refNames(value)) expect(declared).toContain(name);
  }
}

describe('a shape stated more than once is stated once', () => {
  const protocol = {
    state: {},
    commands: {
      setMaterial: {
        description: 'Set material maps',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            map: TEXTURE_SLOT,
            alphaMap: TEXTURE_SLOT,
            normalMap: TEXTURE_SLOT,
          },
          required: ['id'],
        },
      },
      addPrimitive: {
        description: 'Add a primitive',
        params: {
          type: 'object',
          properties: { position: VEC3, scale: VEC3 },
          required: ['position'],
        },
      },
      moveNode: {
        description: 'Move a node',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, to: VEC3 },
          required: ['id', 'to'],
        },
      },
    },
  };

  test('the repeated subschema becomes one $defs entry and a pointer at each use', () => {
    const out = dedupeProtocolSchemas(protocol);

    const material = out.commands!.setMaterial.params as Record<string, any>;
    expect(material.properties.map).toEqual({ $ref: expect.stringContaining('#/$defs/') });
    expect(material.properties.alphaMap).toEqual(material.properties.map);
    // The name is derived from the shape, because the reader is a model: `__schema0`
    // documents nothing.
    expect(material.properties.map.$ref).toBe('#/$defs/uri_repeat_offset_etc');
    expect(out.$defs!.uri_repeat_offset_etc).toEqual(TEXTURE_SLOT);
  });

  test('sharing reaches across commands, not only within one', () => {
    const out = dedupeProtocolSchemas(protocol);
    const add = out.commands!.addPrimitive.params as Record<string, any>;
    const move = out.commands!.moveNode.params as Record<string, any>;
    expect(add.properties.position).toEqual({ $ref: '#/$defs/x_y_z' });
    expect(move.properties.to).toEqual({ $ref: '#/$defs/x_y_z' });
    expect(out.$defs!.x_y_z).toEqual(VEC3);
  });

  test('resolving every ref reproduces the input exactly', () => {
    expectLossless(protocol, dedupeProtocolSchemas(protocol));
  });

  test('no ref points at a def that is not there', () => {
    expectNoDanglingRefs(dedupeProtocolSchemas(protocol));
  });

  test('it is smaller, which is the whole point', () => {
    const before = JSON.stringify(protocol).length;
    const after = JSON.stringify(dedupeProtocolSchemas(protocol)).length;
    expect(after).toBeLessThan(before);
  });

  test('running it again changes nothing', () => {
    // The compile and the deploy-time re-derivation both call the pass; a
    // non-idempotent one would report every deploy as a protocol change.
    const once = dedupeProtocolSchemas(protocol);
    expect(JSON.stringify(dedupeProtocolSchemas(once))).toBe(JSON.stringify(once));
  });

  test('the input is not mutated', () => {
    const before = JSON.stringify(protocol);
    dedupeProtocolSchemas(protocol);
    expect(JSON.stringify(protocol)).toBe(before);
  });

  test('two runs over the same input produce the same bytes', () => {
    expect(JSON.stringify(dedupeProtocolSchemas(protocol))).toBe(
      JSON.stringify(dedupeProtocolSchemas(protocol)),
    );
  });
});

describe('what the pass refuses to touch', () => {
  test("a descriptor's own params is never replaced by a ref, even when two commands share it", () => {
    // The iframe bridge rejects a call by reading `params.properties` and
    // `params.required` directly, and `renderSignature` reads the same two. A
    // `params` behind a pointer would turn both into "declares nothing" — weaker
    // validation with no error anywhere.
    const shared = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to read' },
        encoding: { type: 'string', description: 'Text encoding, defaults to utf-8' },
      },
      required: ['path'],
    };
    const out = dedupeProtocolSchemas({
      commands: {
        readFile: { description: 'Read', params: shared },
        statFile: { description: 'Stat', params: shared },
      },
    });

    expect(out.commands!.readFile.params).toEqual(shared);
    expect(out.commands!.statFile.params).toEqual(shared);
    expect(out.$defs).toBeUndefined();
  });

  test('a shape too small to pay for a pointer stays inline', () => {
    const tiny = { type: 'string' };
    const out = dedupeProtocolSchemas({
      commands: {
        a: { description: 'a', params: { type: 'object', properties: { x: tiny, y: tiny } } },
      },
    });
    expect(out.$defs).toBeUndefined();
    expect((out.commands!.a.params as any).properties.x).toEqual(tiny);
  });

  test('a shape used once is left where it is', () => {
    const out = dedupeProtocolSchemas({
      commands: { a: { description: 'a', params: { type: 'object', properties: { v: VEC3 } } } },
    });
    expect(out.$defs).toBeUndefined();
  });

  test('a protocol with no schemas gains no $defs key at all', () => {
    const plain = {
      state: { count: { description: 'How many' } },
      commands: { ping: { description: 'Ping' } },
      keybindings: { 'Ctrl+p': 'ping' },
    };
    const out = dedupeProtocolSchemas(plain);
    expect('$defs' in out).toBe(false);
    expect(out.keybindings).toEqual({ 'Ctrl+p': 'ping' });
  });

  test('a repeated object that is not in a subschema position is left alone', () => {
    // `examples` holds values, not schemas. Treating an arbitrary object as a schema
    // is how a dedup pass corrupts a manifest, so unrecognized keys are copied.
    const sample = { alpha: 'one', beta: 'two', gamma: 'three', delta: 'four', epsilon: 'five' };
    const out = dedupeProtocolSchemas({
      commands: {
        a: { description: 'a', params: { type: 'object', examples: [sample, sample] } },
      },
    });
    expect(out.$defs).toBeUndefined();
    expect((out.commands!.a.params as any).examples).toEqual([sample, sample]);
  });
});

describe("zod's own per-descriptor $defs is promoted, not left where it lands", () => {
  // `reused: 'ref'` emits a `$defs` local to one descriptor. Its `#/$defs/...`
  // pointers resolve against the *document* root, which is protocol.json once the
  // descriptor is embedded — so left alone they would point into nothing.
  const zodShaped = {
    commands: {
      setMaterial: {
        description: 'Set material maps',
        params: {
          type: 'object',
          properties: {
            map: { $ref: '#/$defs/__schema0' },
            alphaMap: { $ref: '#/$defs/__schema0' },
          },
          $defs: { __schema0: TEXTURE_SLOT },
        },
      },
    },
  };

  test('the local table moves to the protocol and the opaque name is replaced', () => {
    const out = dedupeProtocolSchemas(zodShaped);
    const params = out.commands!.setMaterial.params as Record<string, any>;
    expect('$defs' in params).toBe(false);
    expect(params.properties.map).toEqual({ $ref: '#/$defs/uri_repeat_offset_etc' });
    expect(out.$defs!.uri_repeat_offset_etc).toEqual(TEXTURE_SLOT);
  });

  test('a promoted def and an inlined copy elsewhere collapse into one', () => {
    const out = dedupeProtocolSchemas({
      commands: {
        ...zodShaped.commands,
        setDecal: {
          description: 'Set a decal',
          params: { type: 'object', properties: { map: TEXTURE_SLOT } },
        },
      },
    });
    expect(Object.keys(out.$defs!)).toEqual(['uri_repeat_offset_etc']);
    expect((out.commands!.setDecal.params as any).properties.map).toEqual({
      $ref: '#/$defs/uri_repeat_offset_etc',
    });
  });

  test('a promoted def no bigger than a pointer to it goes back inline', () => {
    // zod hoists by instance identity and applies no size rule, so a single reused
    // `z.number()` const arrives as a def costing more at every use than the shape.
    const out = dedupeProtocolSchemas({
      commands: {
        move: {
          description: 'Move',
          params: {
            type: 'object',
            properties: {
              x: { $ref: '#/$defs/__schema0' },
              y: { $ref: '#/$defs/__schema0' },
              z: { $ref: '#/$defs/__schema0' },
            },
            $defs: { __schema0: { type: 'number' } },
          },
        },
      },
    });

    expect(out.$defs).toBeUndefined();
    expect((out.commands!.move.params as any).properties).toEqual({
      x: { type: 'number' },
      y: { type: 'number' },
      z: { type: 'number' },
    });
  });

  test('a promoted def that does pay for itself is kept, however often it is used', () => {
    const out = dedupeProtocolSchemas({
      commands: {
        setMaterial: {
          description: 'Set material maps',
          params: {
            type: 'object',
            properties: {
              map: { $ref: '#/$defs/__schema0' },
              alphaMap: { $ref: '#/$defs/__schema0' },
            },
            $defs: { __schema0: TEXTURE_SLOT },
          },
        },
      },
    });
    expect(Object.keys(out.$defs!)).toEqual(['uri_repeat_offset_etc']);
  });

  test('a self-referential local def survives promotion instead of hanging', () => {
    const out = dedupeProtocolSchemas({
      commands: {
        addNode: {
          description: 'Add a node',
          params: {
            type: 'object',
            properties: { root: { $ref: '#/$defs/__schema0' } },
            $defs: {
              __schema0: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  children: { type: 'array', items: { $ref: '#/$defs/__schema0' } },
                },
              },
            },
          },
        },
      },
    });

    const names = Object.keys(out.$defs!);
    expect(names).toHaveLength(1);
    const def = out.$defs![names[0]] as any;
    expect(def.properties.children.items).toEqual({ $ref: `#/$defs/${names[0]}` });
    expectNoDanglingRefs(out);
  });
});

describe('an existing $defs table is honored', () => {
  test('names already in use are kept, so a second pass is a no-op', () => {
    const input = {
      commands: {
        a: {
          description: 'a',
          params: { type: 'object', properties: { v: { $ref: '#/$defs/vec3' } } },
        },
        b: {
          description: 'b',
          params: { type: 'object', properties: { w: { $ref: '#/$defs/vec3' } } },
        },
      },
      $defs: { vec3: VEC3 },
    };
    const out = dedupeProtocolSchemas(input);
    expect(out.$defs).toEqual({ vec3: VEC3 });
    expect((out.commands!.a.params as any).properties.v).toEqual({ $ref: '#/$defs/vec3' });
  });

  test('a def nothing points at is dropped', () => {
    const out = dedupeProtocolSchemas({
      commands: { a: { description: 'a', params: { type: 'object', properties: {} } } },
      $defs: { orphan: VEC3 },
    });
    expect(out.$defs).toBeUndefined();
  });
});

describe('state schemas and returns are folded too', () => {
  test('a shape shared between a state schema and a command return is hoisted once', () => {
    const input = {
      state: {
        selection: {
          description: 'What is selected',
          schema: { type: 'object', properties: { at: VEC3 } },
        },
      },
      commands: {
        probe: { description: 'Probe', returns: { type: 'object', properties: { hit: VEC3 } } },
      },
    };
    const out = dedupeProtocolSchemas(input);
    expect(Object.keys(out.$defs!)).toEqual(['x_y_z']);
    expectLossless(input, out);
  });
});
