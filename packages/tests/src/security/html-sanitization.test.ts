/**
 * Adversarial fixtures for the app-side HTML sanitization boundary (Phase 1 of the
 * app library integration proposal).
 *
 * Apps render HTML they did not author — scraped forum posts, RSS bodies, GitHub
 * READMEs, Markdown files out of storage. Every one of those pipelines runs through
 * DOMPurify before the string reaches a DOM sink, via the SDK's `sanitizeHtml`.
 * These tests pin the two things that can silently break that boundary:
 *
 *   1. DOMPurify's behavior on the fixtures the proposal calls out, under the exact
 *      config `sanitizeHtml` passes. A dependency bump that changed any of these
 *      would otherwise land silently.
 *   2. That the config is still what it says, and that every app still goes through
 *      it. The policy started duplicated per app; the SDK primitive collapsed the
 *      copies, so what is pinned now is the one implementation plus the absence of
 *      any app that reaches around it.
 *
 * ## Why jsdom and not happy-dom
 *
 * DOMPurify checks `isSupported` and silently degrades to a passthrough no-op when
 * the host DOM is too incomplete. Under happy-dom — which the frontend package uses
 * for component tests — that check fails, so `javascript:` hrefs sail through
 * untouched while happy-dom's own parser drops benign `<table>`/`<ul>` wrappers.
 * The result is false passes and false failures in the same run. Two separate agents
 * writing this migration were misled by exactly that before switching to jsdom.
 *
 * The `isSupported` assertion below is not ceremony: it is the guard that keeps this
 * entire file from degrading into a suite that passes while testing nothing.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

const REPO_ROOT = join(import.meta.dir, '../../../..');

// jsdom's `window` is declared as `unknown` locally (see jsdom.d.ts for why this
// package cannot pull in lib.dom); DOMPurify only needs it to satisfy its WindowLike.
const DOMPurify = createDOMPurify(new JSDOM('').window as Parameters<typeof createDOMPurify>[0]);

/**
 * The single deviation from DOMPurify's defaults that every YAAR app applies.
 *
 * `form` and its controls sit on the default ALLOWED_TAGS — correct for a
 * general-purpose sanitizer, wrong for an app iframe. No foreign content YAAR
 * renders has a legitimate form in it, while a form styled as app chrome can collect
 * a password and POST it cross-origin. The controls are forbidden alongside `form`
 * so removing the wrapper does not leave orphaned inputs behind.
 */
const FORBID_FORM_TAGS = ['form', 'input', 'button', 'select', 'textarea', 'option'];
const APP_CONFIG = { FORBID_TAGS: FORBID_FORM_TAGS };

/**
 * Anything that executes script or hijacks navigation. Neither the default config
 * nor the app config may ever let one of these through.
 */
const EXECUTABLE = /javascript:|\son\w+\s*=|<script|<iframe|<object|<embed|<base/i;

/**
 * Form markup. DOMPurify's defaults permit this — which is precisely why apps pass
 * FORBID_TAGS — so it is asserted only against the app config.
 */
const FORM_MARKUP = /<form|<input|<button|<select|<textarea/i;

describe('DOMPurify is actually running', () => {
  test('the jsdom host satisfies isSupported', () => {
    // If this fails, every other assertion in this file is vacuous.
    expect(DOMPurify.isSupported).toBe(true);
  });

  test('a known-dangerous fixture is demonstrably altered', () => {
    // Guards against a passthrough no-op that would let the suite go green.
    const dirty = '<script>alert(1)</script>';
    expect(DOMPurify.sanitize(dirty)).not.toBe(dirty);
  });
});

describe('adversarial fixtures do not survive', () => {
  const fixtures: Record<string, string> = {
    script: '<script>alert(1)</script>',
    iframe: '<iframe src="javascript:alert(1)"></iframe>',
    object: '<object data="data:text/html,<script>alert(1)</script>"></object>',
    embed: '<embed src="javascript:alert(1)">',
    base: '<base href="//evil.test/">',
    form: '<form action="//evil.test"><input name="password"></form>',
    'nested form': '<form><form><input formaction="javascript:alert(1)"></form></form>',
    'form in table':
      '<div><form><table><form><input formaction=javascript:alert(1)></form></table></form></div>',
    'svg script': '<svg><script>alert(1)</script></svg>',
    'svg animate': '<svg><animate onbegin="alert(1)" attributeName="x"></animate></svg>',
    'math mtext mXSS': '<math><mtext><style><img src=x onerror=alert(1)></style></mtext></math>',
    'javascript: href': '<a href="javascript:alert(1)">click</a>',
    'inline onerror': '<img src=x onerror=alert(1)>',
    'inline onload': '<body onload=alert(1)>',
    'autofocus onfocus': '<input onfocus="alert(1)" autofocus>',
    formaction: '<button formaction="javascript:alert(1)">go</button>',
    'xlink:href': '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  };

  for (const [name, dirty] of Object.entries(fixtures)) {
    test(`${name} — default config`, () => {
      expect(DOMPurify.sanitize(dirty)).not.toMatch(EXECUTABLE);
    });

    test(`${name} — app config`, () => {
      const out = DOMPurify.sanitize(dirty, APP_CONFIG);
      expect(out).not.toMatch(EXECUTABLE);
      expect(out).not.toMatch(FORM_MARKUP);
    });
  }

  test('forbidding a tag does not leak its attributes via re-parenting', () => {
    // DOMPurify lifts a forbidden node's children (KEEP_CONTENT) rather than
    // discarding them. This asserts the lifted subtree is still sanitized — i.e.
    // that FORBID_TAGS is not weaker than the default it deviates from.
    const dirty =
      '<form><input formaction="javascript:alert(1)"><img src=x onerror=alert(1)></form>';
    const out = DOMPurify.sanitize(dirty, APP_CONFIG);
    expect(out).not.toMatch(EXECUTABLE);
    expect(out).not.toMatch(FORM_MARKUP);
    expect(out).not.toContain('formaction');
  });

  test('the app config removes form controls rather than orphaning them', () => {
    const out = DOMPurify.sanitize('<form><input name="pw"><button>go</button></form>', APP_CONFIG);
    expect(out).not.toContain('<input');
    expect(out).not.toContain('<button');
  });
});

describe('benign rich content survives', () => {
  // A sanitizer that strips everything passes the adversarial half of this file
  // perfectly. These are the assertions that make the suite meaningful.
  const cases: Record<string, string[]> = {
    '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>': [
      '<table',
      '<th',
      '<td',
    ],
    '<pre><code class="language-js">const a = 1;</code></pre>': ['<pre', '<code', 'language-js'],
    '<img src="https://example.test/a.png" alt="a">': ['<img', 'https://example.test/a.png'],
    '<a href="https://example.test">link</a>': ['<a', 'https://example.test'],
    '<ul><li>one</li><li>two</li></ul>': ['<ul', '<li'],
    '<blockquote><p>quoted</p></blockquote>': ['<blockquote', '<p'],
    '<h1>Title</h1><h2>Sub</h2>': ['<h1', '<h2'],
    '<p><strong>b</strong> and <em>i</em></p>': ['<strong', '<em'],
  };

  for (const [dirty, expected] of Object.entries(cases)) {
    test(dirty.slice(0, 48), () => {
      const out = DOMPurify.sanitize(dirty, APP_CONFIG);
      for (const fragment of expected) expect(out).toContain(fragment);
    });
  }

  test('relative URLs are preserved verbatim, not stripped or absolutized', () => {
    // Apps that rewrite repo-relative URLs to absolute ones do so in a pass that
    // runs AFTER sanitization, so they depend on them surviving intact.
    const out = DOMPurify.sanitize('<img src="./docs/a.png"><a href="../b.md">x</a>', APP_CONFIG);
    expect(out).toContain('./docs/a.png');
    expect(out).toContain('../b.md');
  });
});

describe('known gaps are documented, not assumed closed', () => {
  test('style attributes pass through unparsed', () => {
    // DOMPurify does NOT CSS-parse style values. The proposal claimed this gap was
    // closed by the migration; it is not. The listed vectors are inert in modern
    // browsers, which is why apps still allow `style` — but the next person to
    // reach for a CSS-based defense should learn it from a test, not an incident.
    const out = DOMPurify.sanitize('<p style="width:expression(alert(1));color:red">x</p>');
    expect(out).toContain('expression(alert(1))');
  });
});

/**
 * Every app source file that reaches for a sanitizer, found by scanning rather than
 * by list, split by which one it reached for.
 *
 * This used to be a hardcoded roster of `[app, file]` pairs, which fails in both
 * directions: a *new* app that copies the policy wrong is simply absent from the
 * list and never checked, and a *removed* app takes the suite down with an ENOENT
 * (which is how unbundling `dc-comics` broke it). Discovery closes both — anything
 * that reaches for the sanitizer is held to the policy from its first commit, and
 * an app leaving the tree is a non-event.
 *
 * `direct` is the set that imports `@bundled/dompurify` itself. It exists to be
 * asserted empty: the policy now lives once in the SDK's `sanitizeHtml`, and an app
 * that goes around it is writing its own config again — the drift this file was
 * built to catch.
 */
function findSanitizingAppFiles(): { viaSdk: string[]; direct: string[] } {
  const appsDir = join(REPO_ROOT, 'apps');
  const viaSdk: string[] = [];
  const direct: string[] = [];
  for (const app of readdirSync(appsDir, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const srcDir = join(appsDir, app.name, 'src');
    if (!existsSync(srcDir)) continue;
    for (const rel of readdirSync(srcDir, { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(rel)) continue;
      const abs = join(srcDir, rel);
      if (!statSync(abs).isFile()) continue;
      const src = readFileSync(abs, 'utf8');
      const file = join(app.name, 'src', rel);
      if (src.includes('@bundled/dompurify')) direct.push(file);
      if (/\bsanitizeHtml\b/.test(src) && src.includes('@bundled/yaar')) viaSdk.push(file);
    }
  }
  return { viaSdk: viaSdk.sort(), direct: direct.sort() };
}

describe('app sanitize policies have not drifted', () => {
  const { viaSdk: SANITIZING_FILES, direct: DIRECT_DOMPURIFY_FILES } = findSanitizingAppFiles();

  /**
   * Apps that must never stop sanitizing, by id rather than by file path.
   *
   * Discovery alone cannot catch an app that deletes its `sanitizeHtml` import and
   * starts writing foreign HTML to a DOM sink raw — it would just drop off the scan
   * and every assertion below would still pass. This floor is what makes that a
   * failure. Keyed on the app id, not a file, so refactoring inside the app is free;
   * only unbundling the app itself needs a line removed here.
   */
  const MUST_SANITIZE = ['storage'];

  for (const app of MUST_SANITIZE) {
    test(`${app} still sanitizes somewhere in its source`, () => {
      expect(SANITIZING_FILES.filter((f) => f.startsWith(`${app}/`))).not.toEqual([]);
    });
  }

  test('no app imports @bundled/dompurify directly', () => {
    // The config below is asserted once, against the shim. An app that constructs
    // its own DOMPurify call is outside that assertion — which is the state this
    // file used to pin per-file, and the state the SDK primitive exists to end.
    expect(DIRECT_DOMPURIFY_FILES).toEqual([]);
  });

  test('the SDK sanitizer forbids exactly the canonical form tags', () => {
    // The policy is no longer duplicated per app, so it is pinned where it now
    // lives. `sanitizeHtml` is the only thing standing between foreign markup and
    // an app's DOM; dropping `input` from this list starts orphaning controls
    // instead of removing them, and nothing else in the tree would notice.
    const shim = readFileSync(
      join(REPO_ROOT, 'packages/compiler/src/shims/yaar/sanitize.ts'),
      'utf8',
    );
    const canonical = FORBID_FORM_TAGS.map((t) => `'${t}'`).join(', ');
    expect(shim.replace(/\s+/g, ' ')).toContain(`[${canonical}]`);
  });

  test('no app generates inline event handler attributes', () => {
    // Step 5 of the ordering contract: behavior attaches via addEventListener.
    // A generated `onerror` is stripped by any sanitizer, so the behavior it
    // encodes disappears the moment the pipeline is secured.
    const offenders = SANITIZING_FILES.filter((file) =>
      /setAttribute\(\s*['"`]on\w+/i.test(readFileSync(join(REPO_ROOT, 'apps', file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
