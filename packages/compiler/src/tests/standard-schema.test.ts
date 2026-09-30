/**
 * `describeIssues` is the one line both SDK doors (`defineApp`, `safeParseOr`) show for a
 * rejected value. `@bundled/zod` is `zod/mini`, which carries no locale, so every issue
 * arrives reading "Invalid input" — these cases pin that the structured fields fill the
 * gap, run against real `zod/mini` issues rather than hand-built ones.
 */
import { describe, expect, test } from 'bun:test';
import * as z from 'zod/mini';
import { describeIssues } from '../shims/yaar/standard-schema.js';

async function issuesOf(schema: z.ZodMiniType, value: unknown) {
  const result = await schema['~standard'].validate(value);
  if (!('issues' in result) || !result.issues) throw new Error('expected a rejection');
  return result.issues;
}

describe('describeIssues over bare zod/mini messages', () => {
  test('a rejected enum names the allowed values', async () => {
    const issues = await issuesOf(z.object({ type: z.enum(['cube', 'plane']) }), {
      type: 'torus',
    });
    expect(describeIssues(issues)).toBe('type: Invalid input: expected one of "cube" | "plane"');
  });

  test('a literal, a type miss and a primitive union say what they expected', async () => {
    const schema = z.object({
      lit: z.literal(3),
      n: z.number(),
      u: z.union([z.string(), z.number()]),
    });
    const text = describeIssues(await issuesOf(schema, { lit: 4, n: 'a', u: true }));
    expect(text).toContain('lit: Invalid input: expected 3');
    expect(text).toContain('n: Invalid input: expected number');
    expect(text).toContain('u: Invalid input: expected string | number');
  });

  test('a bound says which bound', async () => {
    const schema = z.object({ s: z.string().check(z.minLength(2)), k: z.number().check(z.lte(5)) });
    const text = describeIssues(await issuesOf(schema, { s: 'a', k: 9 }));
    expect(text).toContain('s: Invalid input: expected length >= 2');
    expect(text).toContain('k: Invalid input: expected <= 5');
  });

  test('a message that already says something is left alone', () => {
    const issues = [
      { code: 'invalid_value', values: ['a'], path: ['x'], message: 'pick a real one' },
    ];
    expect(describeIssues(issues)).toBe('x: pick a real one');
  });

  test('an issue with nothing structured keeps its bare message', () => {
    expect(describeIssues([{ code: 'custom', path: ['x'], message: 'Invalid input' }])).toBe(
      'x: Invalid input',
    );
  });
});
