import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { APP_MOUNT_ID, scanMountTargets } from '../guards/mount-guard.js';

const scan = (source: string) => scanMountTargets(ts, source, 'src/main.ts');

describe('scanMountTargets', () => {
  test('accepts the mount point the compiler emits', () => {
    expect(scan(`render(() => App(), document.getElementById('${APP_MOUNT_ID}')!);`)).toEqual([]);
  });

  test('flags the wrong id inline', () => {
    const findings = scan(`render(() => App(), document.getElementById('root')!);`);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('root');
    expect(findings[0].line).toBe(1);
  });

  test('flags the wrong id through a variable — how it actually gets written', () => {
    const findings = scan(`
      const el = document.getElementById('root');
      if (!el) return;
      render(() => App(), el);
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('root');
  });

  test('flags a querySelector id selector', () => {
    expect(scan(`render(App, document.querySelector('#root')!);`)[0].id).toBe('root');
  });

  test('accepts querySelector on the real mount point', () => {
    expect(scan(`render(App, document.querySelector('#${APP_MOUNT_ID}')!);`)).toEqual([]);
  });

  test('ignores a lookup on a parsed document, not the page', () => {
    // thesingularity-reader does exactly this with a DOMParser result.
    const findings = scan(`
      const doc = parser.parseFromString(s, 'text/html');
      const root = doc.getElementById('__inline_root');
      render(() => App(), document.getElementById('${APP_MOUNT_ID}')!);
    `);
    expect(findings).toEqual([]);
  });

  test('ignores element lookups that are not the render target', () => {
    // Apps legitimately query ids in markup they rendered themselves.
    const findings = scan(`
      render(() => App(), document.getElementById('${APP_MOUNT_ID}')!);
      const canvas = document.getElementById('canvas');
    `);
    expect(findings).toEqual([]);
  });

  test('leaves a computed target alone rather than guessing', () => {
    expect(scan(`render(App, host);`)).toEqual([]);
    expect(scan(`render(App, document.createElement('div'));`)).toEqual([]);
    expect(scan(`render(App, document.getElementById(id)!);`)).toEqual([]);
  });

  test('ignores a non-id querySelector', () => {
    expect(scan(`render(App, document.querySelector('.host')!);`)).toEqual([]);
  });

  test('sees through `as HTMLElement` and parens', () => {
    const findings = scan(`render(App, (document.getElementById('root') as HTMLElement));`);
    expect(findings[0].id).toBe('root');
  });

  test('a single-argument render is not a mount', () => {
    expect(scan(`render(App);`)).toEqual([]);
  });
});
