import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative, resolve } from 'path';
import { initCompiler } from './config.js';
import { typecheckSandbox } from './typecheck.js';

setDefaultTimeout(15_000);

beforeAll(() => {
  initCompiler({
    projectRoot: resolve(import.meta.dir, '../../..'),
    isBundledExe: false,
  });
});

async function check(source: string, bundles?: string[], useRelativePath = false) {
  const sandbox = await mkdtemp(join(tmpdir(), 'yaar-typecheck-'));
  try {
    await mkdir(join(sandbox, 'src'));
    await Bun.write(join(sandbox, 'src', 'main.ts'), source);
    return await typecheckSandbox(useRelativePath ? relative(process.cwd(), sandbox) : sandbox, {
      bundles,
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

describe('typecheckSandbox bundle gates', () => {
  test('keeps the base SDK available and accepts a relative sandbox path', async () => {
    const result = await check(
      `
        import { errMsg } from '@bundled/yaar';
        export const message = errMsg(new Error('boom'));
      `,
      undefined,
      true,
    );
    expect(result).toEqual({ success: true, diagnostics: [] });
  });

  test('rejects a gated SDK without its app.json bundle', async () => {
    const result = await check(`
      import { open } from '@bundled/yaar-web';
      export const openPage = open;
    `);
    expect(result.success).toBeFalse();
    expect(result.diagnostics.join('\n')).toContain("Cannot find module '@bundled/yaar-web'");
  });

  test('accepts a gated SDK when its bundle is granted', async () => {
    const result = await check(
      `
        import { open } from '@bundled/yaar-web';
        export const openPage = open;
      `,
      ['yaar-web'],
    );
    expect(result).toEqual({ success: true, diagnostics: [] });
  });

  test('granting one gated SDK does not expose another', async () => {
    const result = await check(
      `
        import { compile } from '@bundled/yaar-dev';
        export const compileApp = compile;
      `,
      ['yaar-web'],
    );
    expect(result.success).toBeFalse();
    expect(result.diagnostics.join('\n')).toContain("Cannot find module '@bundled/yaar-dev'");
  });
});
