/**
 * The framing-policy read behind `GET /api/embeddable`.
 *
 * The desktop routes a link on this verdict — an iframe window when the site permits
 * framing, the Browser app when it does not — so the two ways to be wrong are both
 * user-visible: call x.com framable and the window opens on nothing, call a framable
 * site refused and every ordinary link is shunted onto a heavier surface.
 *
 * These are header tests on purpose. The network half is one `safeFetch` whose only
 * interesting property (any failure answers "embeddable") is asserted by its absence
 * of branching, while the parsing is where the real cases live: the `'self'` that
 * names the *resource*, ports written both ways, CSP superseding X-Frame-Options.
 */
import { describe, it, expect } from 'bun:test';
import { verdictFromHeaders } from '../features/http/embeddable.js';

const DESKTOP = 'http://localhost:8000';

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe('verdictFromHeaders', () => {
  it('permits framing when the response says nothing about it', () => {
    expect(verdictFromHeaders(headers({}), 'https://example.com/', DESKTOP)).toEqual({
      embeddable: true,
    });
  });

  it("refuses when frame-ancestors names only the site's own origins", () => {
    // Verbatim from x.com — the policy that started this.
    const csp =
      "frame-ancestors 'self' https://x.com https://x.com:443 https://twitter.com https://twitter.com:443";
    const verdict = verdictFromHeaders(
      headers({ 'content-security-policy': csp }),
      'https://x.com/',
      DESKTOP,
    );
    expect(verdict.embeddable).toBe(false);
    expect(verdict.reason).toContain('frame-ancestors');
  });

  it("reads 'self' against the framed resource, not the ancestor", () => {
    const h = headers({ 'content-security-policy': "frame-ancestors 'self'" });
    // The desktop framing itself is the one case 'self' admits.
    expect(verdictFromHeaders(h, `${DESKTOP}/page`, DESKTOP).embeddable).toBe(true);
    expect(verdictFromHeaders(h, 'https://example.com/', DESKTOP).embeddable).toBe(false);
  });

  it("refuses frame-ancestors 'none'", () => {
    const verdict = verdictFromHeaders(
      headers({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }),
      'https://example.com/',
      DESKTOP,
    );
    expect(verdict.embeddable).toBe(false);
  });

  it('permits when the ancestor is named explicitly, with or without the default port', () => {
    for (const source of ['http://localhost:8000', 'http://localhost:8000/some/path', '*']) {
      expect(
        verdictFromHeaders(
          headers({ 'content-security-policy': `frame-ancestors ${source}` }),
          'https://example.com/',
          DESKTOP,
        ).embeddable,
      ).toBe(true);
    }
    // A port that does not match is a refusal, even on the right host.
    expect(
      verdictFromHeaders(
        headers({ 'content-security-policy': 'frame-ancestors http://localhost:3000' }),
        'https://example.com/',
        DESKTOP,
      ).embeddable,
    ).toBe(false);
  });

  it('normalizes an implicit default port on the ancestor side', () => {
    expect(
      verdictFromHeaders(
        headers({ 'content-security-policy': 'frame-ancestors https://desktop.example:443' }),
        'https://example.com/',
        'https://desktop.example',
      ).embeddable,
    ).toBe(true);
  });

  it('matches a wildcard host only on subdomains', () => {
    const h = headers({ 'content-security-policy': 'frame-ancestors https://*.example.com' });
    expect(verdictFromHeaders(h, 'https://site.test/', 'https://app.example.com').embeddable).toBe(
      true,
    );
    expect(verdictFromHeaders(h, 'https://site.test/', 'https://example.com').embeddable).toBe(
      false,
    );
  });

  it('matches a scheme-only source', () => {
    const h = headers({ 'content-security-policy': 'frame-ancestors https:' });
    expect(verdictFromHeaders(h, 'https://site.test/', 'https://desktop.test').embeddable).toBe(
      true,
    );
    expect(verdictFromHeaders(h, 'https://site.test/', DESKTOP).embeddable).toBe(false);
  });

  it('requires every policy to admit the ancestor when several are joined', () => {
    // Two CSP headers arrive comma-joined; the second one refuses.
    const h = headers({
      'content-security-policy': "frame-ancestors *, frame-ancestors 'none'",
    });
    expect(verdictFromHeaders(h, 'https://example.com/', DESKTOP).embeddable).toBe(false);
  });

  it('ignores CSP directives that are not frame-ancestors', () => {
    const h = headers({
      'content-security-policy': "default-src 'none'; script-src 'self'; img-src *",
    });
    expect(verdictFromHeaders(h, 'https://example.com/', DESKTOP).embeddable).toBe(true);
  });

  it('honors X-Frame-Options when no frame-ancestors directive is present', () => {
    expect(
      verdictFromHeaders(headers({ 'x-frame-options': 'DENY' }), 'https://example.com/', DESKTOP)
        .embeddable,
    ).toBe(false);
    expect(
      verdictFromHeaders(
        headers({ 'x-frame-options': 'sameorigin' }),
        'https://example.com/',
        DESKTOP,
      ).embeddable,
    ).toBe(false);
    // SAMEORIGIN from the desktop's own origin is not a refusal.
    expect(
      verdictFromHeaders(headers({ 'x-frame-options': 'SAMEORIGIN' }), `${DESKTOP}/x`, DESKTOP)
        .embeddable,
    ).toBe(true);
  });

  it('lets frame-ancestors supersede a contradicting X-Frame-Options', () => {
    // Both present is common on older stacks, and the browser obeys CSP.
    const h = headers({
      'x-frame-options': 'DENY',
      'content-security-policy': 'frame-ancestors *',
    });
    expect(verdictFromHeaders(h, 'https://example.com/', DESKTOP).embeddable).toBe(true);
  });

  it('permits framing rather than guessing when the ancestor origin is unparseable', () => {
    expect(
      verdictFromHeaders(
        headers({ 'content-security-policy': "frame-ancestors 'none'" }),
        'https://example.com/',
        'not-an-origin',
      ).embeddable,
    ).toBe(true);
  });
});
