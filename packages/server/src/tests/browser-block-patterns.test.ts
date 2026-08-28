import { describe, it, expect } from 'bun:test';
import { compileBlockPatterns } from '../features/browser/actions.js';

describe('compileBlockPatterns', () => {
  it('turns a host into a suffix rule: the host itself and every subdomain', () => {
    expect(compileBlockPatterns({ hosts: ['doubleclick.net'] })).toEqual([
      '*://doubleclick.net/*',
      '*://*.doubleclick.net/*',
    ]);
  });

  it('normalises leading wildcards/dots and case, and drops blanks', () => {
    expect(compileBlockPatterns({ hosts: ['*.Ads.Test', '.x.y', '  ', ''] })).toEqual([
      '*://ads.test/*',
      '*://*.ads.test/*',
      '*://x.y/*',
      '*://*.x.y/*',
    ]);
  });

  it('wraps url substrings and passes raw patterns through, de-duplicated', () => {
    expect(
      compileBlockPatterns({
        urlPatterns: ['/adserver/', '/adserver/'],
        patterns: ['*://cdn.example/*.gif', '*/adserver/*'],
      }),
    ).toEqual(['*/adserver/*', '*://cdn.example/*.gif']);
  });
});
