import { describe, expect, test } from 'bun:test';
import { markdownToHtml, MERMAID_ATTR } from '@/lib/markdown';

/**
 * The mermaid placeholder has one hard requirement: the diagram source has to
 * reach the hydration pass intact. The trap it is written around is DOMPurify's
 * `SAFE_FOR_XML`, on by default, which deletes any attribute whose value
 * contains `-->` — and `A --> B` is most of mermaid's syntax, so carrying the
 * source in an attribute would have lost exactly the diagrams people write. The
 * invariant that can regress is therefore *where* the source sits, which is what
 * these assert: inside a `<code>`, never in an attribute.
 *
 * These run `markdownToHtml`, not `markdownToSafeHtml`, because DOMPurify does
 * not work under happy-dom — it strips `div`/`pre`/`p` and duplicates text — so
 * the sanitized half is verified in a real browser instead. Rendering is not
 * covered either: mermaid needs a layout engine happy-dom does not have.
 */
describe('markdown → mermaid placeholder', () => {
  test('a mermaid fence becomes a pending placeholder', () => {
    const html = markdownToHtml('```mermaid\ngraph TD; A-->B\n```');
    expect(html).toContain(`${MERMAID_ATTR}="pending"`);
  });

  test('the source rides as text content, not as an attribute value', () => {
    const source = 'graph TD;\n  A-->B;\n  B --> C;';
    const html = markdownToHtml('```mermaid\n' + source + '\n```');

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const block = doc.querySelector(`[${MERMAID_ATTR}]`);
    expect(block).not.toBeNull();
    expect(block?.querySelector('code')?.textContent).toBe(source);

    // Nothing on the placeholder may carry diagram syntax — an attribute holding
    // `-->` is silently emptied by the sanitizer that runs next.
    for (const attr of Array.from(block!.attributes)) {
      expect(attr.value).not.toContain('--');
    }
  });

  test('an info string with extra words still counts as mermaid', () => {
    const html = markdownToHtml('```mermaid title=Flow\ngraph TD; A-->B\n```');
    expect(html).toContain(`${MERMAID_ATTR}="pending"`);
  });

  test('diagram source is escaped, not emitted as live markup', () => {
    const html = markdownToHtml('```mermaid\ngraph TD; A["<img src=x onerror=alert(1)>"]\n```');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });

  test('a non-mermaid fence still uses the default code renderer', () => {
    const html = markdownToHtml('```ts\nconst a = 1;\n```');
    expect(html).not.toContain(MERMAID_ATTR);
    expect(html).toContain('<pre><code class="language-ts">');
  });

  test('an indented code block is untouched', () => {
    const html = markdownToHtml('    graph TD; A-->B\n');
    expect(html).not.toContain(MERMAID_ATTR);
  });
});
