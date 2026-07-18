import { describe, expect, it } from 'bun:test';
import { buildTarExtractInvocation } from '../features/apps/archive.js';

describe('marketplace app archive extraction', () => {
  it('keeps Windows drive-letter paths out of tar arguments', () => {
    const invocation = buildTarExtractInvocation(
      String.raw`C:\Users\person\yaar\storage\.tmp`,
      'example-app.tar.gz',
      'staging-example-app',
    );

    expect(invocation.cwd).toBe(String.raw`C:\Users\person\yaar\storage\.tmp`);
    expect(invocation.argv).toEqual([
      'tar',
      'xzf',
      'example-app.tar.gz',
      '--strip-components=1',
      '-C',
      'staging-example-app',
    ]);
    expect(invocation.argv.some((argument) => argument.includes(':'))).toBe(false);
  });
});
