/**
 * One URI, many payloads — the payload axis of a batched call.
 *
 * Brace expansion (`handlers/index.ts`) has always batched the *URI* axis: many URIs
 * against one payload, run concurrently. The complement was missing, and it is the one
 * that costs: authoring a 53-node scene is one call, but the forty follow-up tweaks that
 * each nudge one node were forty calls, because no two payloads were alike.
 *
 * These rows cover the registry's half — the rules that hold whatever the URI names, with
 * a handler that records what it was called with and nothing else. The app-command half
 * (ordering across a real iframe round trip, a real refusal mid-batch) is in
 * `tests/loopback/loopback-window-subpaths.test.ts`, since only a frame arriving through
 * the socket can settle those.
 */
import { describe, it, expect } from 'bun:test';

import { ResourceRegistry, type VerbResult } from '../handlers/uri-registry.js';

/** A handler that answers every invoke, remembering the payloads in order. */
function registryWithRecorder(): { registry: ResourceRegistry; seen: unknown[] } {
  const seen: unknown[] = [];
  const registry = new ResourceRegistry();
  registry.register('yaar://storage/', {
    description: 'A recorder.',
    verbs: ['read', 'invoke'],
    async read(): Promise<VerbResult> {
      return { content: [{ type: 'text', text: 'read' }] };
    },
    async invoke(_resolved, payload): Promise<VerbResult> {
      seen.push(payload);
      // The one id this fixture refuses, so a failure has a real source.
      if (payload?.id === 'boom') {
        return { content: [{ type: 'text', text: 'refused boom' }], isError: true };
      }
      return { content: [{ type: 'text', text: `ok ${String(payload?.id)}` }] };
    },
  });
  return { registry, seen };
}

const textOf = (result: VerbResult): string =>
  result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

describe('a batched invoke is N calls the handler cannot tell apart from N lone ones', () => {
  it('hands each element to the handler as an ordinary payload, in order', async () => {
    const { registry, seen } = registryWithRecorder();

    const result = await registry.execute('invoke', 'yaar://storage/notes', [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);

    // The array never reaches the handler, so batching is not something a resource opts
    // into, implements, or can get wrong — every handler in the tree got it at once.
    expect(seen).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('--- [0] ---');
    expect(textOf(result)).toContain('ok c');
    expect(textOf(result)).toContain('Batch complete: 3 of 3.');
  });

  it('stops at the first failure, and says how many were not attempted', async () => {
    const { registry, seen } = registryWithRecorder();

    const result = await registry.execute('invoke', 'yaar://storage/notes', [
      { id: 'a' },
      { id: 'boom' },
      { id: 'c' },
    ]);

    // Elements are edits to *one* resource, in a stated order: the ones after a failure
    // were written for a state that never happened, so they are reported rather than run.
    expect(seen).toEqual([{ id: 'a' }, { id: 'boom' }]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Batch stopped at [1] of 3: 1 succeeded');
    expect(textOf(result)).toContain('1 not attempted (resend from [1])');
  });
});

describe('the batch form is refused where it means nothing', () => {
  it('only invoke takes an array — the other verbs take one payload or none', async () => {
    const { registry, seen } = registryWithRecorder();

    const result = await registry.execute('read', 'yaar://storage/notes', [{ id: 'a' }]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('only meaningful for invoke');
    expect(seen).toEqual([]);
  });

  it('an empty array is an error, not a no-op reported as success', async () => {
    const { registry } = registryWithRecorder();

    const result = await registry.execute('invoke', 'yaar://storage/notes', []);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('nothing to do');
  });

  it('a list past the cap is refused with the number, never truncated', async () => {
    const { registry, seen } = registryWithRecorder();

    const result = await registry.execute(
      'invoke',
      'yaar://storage/notes',
      Array.from({ length: 101 }, (_, i) => ({ id: `n${i}` })),
    );

    // A silent truncation would report a partial run as a complete one — the failure mode
    // a cap exists to prevent, reintroduced by the cap itself.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('101 payloads');
    expect(textOf(result)).toContain('batch limit of 100');
    expect(seen).toEqual([]);
  });

  it('an element that is not an object is refused before anything runs', async () => {
    const { registry, seen } = registryWithRecorder();

    const result = await registry.execute('invoke', 'yaar://storage/notes', [
      { id: 'a' },
      'nope' as unknown as Record<string, unknown>,
    ]);

    // Checked up front rather than at element 2, so a malformed list does not half-run.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('must be an object');
    expect(seen).toEqual([]);
  });
});
