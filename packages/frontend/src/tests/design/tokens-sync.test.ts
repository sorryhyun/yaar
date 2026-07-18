import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildShellTokensCss } from '@yaar/shared';

/**
 * tokens.css is a generated file checked into the repo. If this fails, someone
 * edited it by hand or changed the token data without regenerating:
 *   bun scripts/gen-design-tokens.ts
 */
describe('shell design tokens', () => {
  test('tokens.css matches the @yaar/shared generator output', () => {
    const cssPath = join(import.meta.dir, '../../styles/base/tokens.css');
    const onDisk = readFileSync(cssPath, 'utf8');
    expect(onDisk).toBe(buildShellTokensCss());
  });
});
