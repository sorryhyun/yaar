/**
 * `injectScriptOnce` backs the eleven (well, ten plus one special case) inline
 * scripts `IframeRenderer` seeds an app frame with — see IframeRenderer.tsx. These
 * pin its contract directly: marker attribute, idempotency, `doc.head` placement,
 * order across repeated calls, and the `doc`-is-null no-op.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { injectScriptOnce } from '@/lib/injectScriptOnce';

function markers(doc: Document): string[] {
  return Array.from(doc.head.querySelectorAll('script')).map((s) =>
    Array.from(s.attributes)
      .map((a) => a.name)
      .find((name) => name.startsWith('data-yaar-')),
  ) as string[];
}

describe('injectScriptOnce', () => {
  let doc: Document;

  beforeEach(() => {
    doc = document.implementation.createHTMLDocument('test');
  });

  it('injects a script marked with the given attribute, in doc.head', () => {
    injectScriptOnce(doc, 'data-yaar-foo', 'window.foo = 1;');
    const script = doc.head.querySelector('script[data-yaar-foo]');
    expect(script).not.toBeNull();
    expect(script?.getAttribute('data-yaar-foo')).toBe('1');
    expect(script?.textContent).toBe('window.foo = 1;');
  });

  it('is a no-op on a second call with the same marker', () => {
    injectScriptOnce(doc, 'data-yaar-foo', 'window.foo = 1;');
    injectScriptOnce(doc, 'data-yaar-foo', 'window.foo = 2;');
    expect(doc.head.querySelectorAll('script[data-yaar-foo]')).toHaveLength(1);
    // The first injection wins — a second call doesn't even overwrite the content.
    expect(doc.head.querySelector('script[data-yaar-foo]')?.textContent).toBe('window.foo = 1;');
  });

  it('preserves call order across several distinct scripts', () => {
    injectScriptOnce(doc, 'data-yaar-a', 'a');
    injectScriptOnce(doc, 'data-yaar-b', 'b');
    injectScriptOnce(doc, 'data-yaar-c', 'c');
    expect(markers(doc)).toEqual(['data-yaar-a', 'data-yaar-b', 'data-yaar-c']);
  });

  it('is a no-op when doc is null or undefined', () => {
    expect(() => injectScriptOnce(null, 'data-yaar-foo', 'window.foo = 1;')).not.toThrow();
    expect(() => injectScriptOnce(undefined, 'data-yaar-foo', 'window.foo = 1;')).not.toThrow();
  });
});
