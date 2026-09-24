import { afterAll, describe, expect, test } from 'bun:test';

/**
 * `icon()` replaced four hand-rolled renderers, and what they agreed on is the
 * contract worth pinning: a fresh SVG-namespace node per call, stroked in
 * `currentColor`, hidden from assistive tech unless it is given a name.
 *
 * `document.createElementNS` is the whole DOM surface, so it is stubbed by hand.
 */

interface FakeNode {
  ns: string;
  tag: string;
  attrs: Record<string, string>;
  children: FakeNode[];
  textContent: string;
  setAttribute(k: string, v: string): void;
  appendChild(c: FakeNode): void;
}

const g = globalThis as unknown as Record<string, unknown>;
const prevDocument = g.document;
g.document = {
  createElementNS: (ns: string, tag: string): FakeNode => ({
    ns,
    tag,
    attrs: {},
    children: [],
    textContent: '',
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    appendChild(c) {
      this.children.push(c);
    },
  }),
};
afterAll(() => {
  g.document = prevDocument;
});

const { icon, Scissors } = await import('../shims/lucide.js');
const SVG_NS = 'http://www.w3.org/2000/svg';

describe('icon', () => {
  test('renders a lucide node as SVG-namespace children', () => {
    const svg = icon(Scissors) as unknown as FakeNode;
    expect(svg.ns).toBe(SVG_NS);
    expect(svg.attrs.stroke).toBe('currentColor');
    expect(svg.attrs.width).toBe('16');
    expect(svg.children.map((c) => c.tag)).toEqual(Scissors.map(([tag]) => tag));
    expect(svg.children.every((c) => c.ns === SVG_NS)).toBe(true);
  });

  test('a fresh node per call', () => {
    expect(icon(Scissors)).not.toBe(icon(Scissors));
  });

  test('options set size, stroke and class', () => {
    const svg = icon(Scissors, { size: 20, strokeWidth: 1.5, class: 'ico' }) as unknown as FakeNode;
    expect(svg.attrs).toMatchObject({
      width: '20',
      height: '20',
      'stroke-width': '1.5',
      class: 'ico',
    });
  });

  test('hidden unless titled, then an image with a <title>', () => {
    const hidden = icon(Scissors) as unknown as FakeNode;
    expect(hidden.attrs['aria-hidden']).toBe('true');
    const named = icon(Scissors, { title: 'Cut' }) as unknown as FakeNode;
    expect(named.attrs.role).toBe('img');
    expect(named.attrs['aria-hidden']).toBeUndefined();
    expect(named.children[0]).toMatchObject({ tag: 'title', textContent: 'Cut' });
  });

  test('an app-drawn IconNode renders through the same call', () => {
    const svg = icon([['circle', { cx: '12', cy: '12', r: '2' }]]) as unknown as FakeNode;
    expect(svg.children).toHaveLength(1);
    expect(svg.children[0]!.attrs).toEqual({ cx: '12', cy: '12', r: '2' });
  });
});
