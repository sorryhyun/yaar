import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { formatMountFindings, scanMountTargets } from '../guards/mount-guard.js';
import { formatFindings, scanSource } from '../guards/solid-html-guard.js';
import { formatTokenFindings, scanTokens } from '../guards/design-token-guard.js';
import { guardHeadline } from '../guards/guard-report.js';

const mountReport = (source: string) =>
  formatMountFindings('src/main.ts', scanMountTargets(ts, source, 'src/main.ts'));

const solidReport = (source: string) =>
  formatFindings('src/main.ts', scanSource(ts, source, 'src/main.ts'));

const tokenReport = (text: string) =>
  formatTokenFindings(scanTokens([{ path: 'src/main.ts', text }]));

describe('guard reports', () => {
  // A guard message raised from a Bun plugin passes through an error path that
  // mangles non-ASCII bytes — an em dash arrives as `â`. Both plugin-raised
  // guards are checked here so the rule cannot be broken in only one of them.
  test('plugin-raised messages are ASCII', () => {
    const reports = [
      mountReport(`render(App, document.getElementById('root')!);`),
      solidReport('const x = html`${value}`;'),
      solidReport('const x = html`lead ${value} <b>b</b>`;'),
      solidReport('const x = html`plain`;'),
    ];
    for (const report of reports) {
      expect(report).not.toBe('');
      // eslint-disable-next-line no-control-regex
      expect(report).toMatch(/^[\x00-\x7F]*$/);
    }
  });

  test('each guard keeps its own headline', () => {
    expect(mountReport(`render(App, document.getElementById('root')!);`)).toStartWith(
      'app mount point: 1 bad render target\n',
    );
    expect(solidReport('const x = html`${value}`;')).toStartWith(
      'solid-js/html: 1 broken template\n',
    );
    expect(tokenReport('var(--yaar-space-2)')).toStartWith('design tokens: 1 undefined token\n');
  });

  test('the headline pluralizes on count, not on label', () => {
    expect(guardHeadline({ label: 'x', noun: 'thing' }, 1)).toBe('x: 1 thing');
    expect(guardHeadline({ label: 'x', noun: 'thing' }, 0)).toBe('x: 0 things');
    expect(guardHeadline({ label: 'x', noun: 'thing' }, 2)).toBe('x: 2 things');
  });

  test('a finding carries file:line:col, a snippet, and both prose lines', () => {
    const report = mountReport(`
      const el = document.getElementById('root');
      render(App, el);
    `);
    expect(report).toContain('src/main.ts:3:19: el');
    expect(report).toContain('  problem: there is no #root element.');
    expect(report).toContain("  fix:     render(App, document.getElementById('app')!)");
  });
});
