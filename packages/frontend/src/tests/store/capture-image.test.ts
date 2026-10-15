/**
 * Capturing a window whose iframe shows an image document (#180).
 *
 * The self-capture handler is a script appended to the document's `<head>`; an SVG document
 * has none, so `__screenshot` of a stored `.svg` used to time out as a bare `no-response`. An
 * image is now drawn by the desktop, and a headless document that cannot answer says so.
 */
import { describe, it, expect } from 'bun:test';
import { captureScale } from '@yaar/shared';
import {
  captureFrameImage,
  fitImageBox,
  frameImageOf,
  handlerlessDocumentType,
  type ImageCaptureDeps,
} from '@/store/iframe-bridge/capture-image';
import { captureIframe } from '@/store/iframe-bridge/capture';

const SVG_NS = 'http://www.w3.org/2000/svg';

function rect(x: number, y: number, width: number, height: number) {
  return () => ({ left: x, top: y, x, y, width, height, right: x + width, bottom: y + height });
}

function frame(opts: { doc?: unknown; src?: string; width?: number; height?: number }) {
  const iframe = document.createElement('iframe');
  if (opts.src) iframe.src = opts.src;
  Object.defineProperty(iframe, 'contentDocument', { value: opts.doc ?? null });
  Object.defineProperty(iframe, 'contentWindow', { value: { postMessage: () => {} } });
  Object.defineProperty(iframe, 'clientWidth', { value: opts.width ?? 800 });
  Object.defineProperty(iframe, 'clientHeight', { value: opts.height ?? 600 });
  return iframe;
}

function svgDocument(attrs: Record<string, string> = {}) {
  const root = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries(attrs)) root.setAttribute(k, v);
  root.appendChild(document.createElementNS(SVG_NS, 'circle'));
  root.getBoundingClientRect = rect(0, 0, 200, 100) as unknown as () => DOMRect;
  return {
    root,
    doc: {
      contentType: 'image/svg+xml',
      documentElement: root,
      head: null,
      URL: 'http://localhost/api/storage/shared/a.svg',
      querySelector: () => null,
    },
  };
}

describe('frameImageOf', () => {
  it('captures a readable SVG document from its live DOM, at the size it is shown', () => {
    const { doc, root } = svgDocument({ width: '200', height: '100' });
    const image = frameImageOf(frame({ doc }));
    expect(image?.contentType).toBe('image/svg+xml');
    expect(image?.box).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    const markup = decodeURIComponent(
      image!.src.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''),
    );
    const scale = captureScale(800, 600);
    expect(markup).toContain('<circle');
    expect(markup).toContain(`width="${Math.round(200 * scale)}"`);
    // No viewBox of its own: given the shown box, so the scaled size scales the drawing.
    expect(markup).toContain('viewBox="0 0 200 100"');
    // The live document itself is left alone.
    expect(root.getAttribute('width')).toBe('200');
  });

  it("keeps an SVG's own viewBox", () => {
    const { doc } = svgDocument({ viewBox: '0 0 10 10' });
    const markup = decodeURIComponent(frameImageOf(frame({ doc }))!.src);
    expect(markup).toContain('viewBox="0 0 10 10"');
  });

  it('loads a readable raster document from its URL, placed where its <img> is', () => {
    const img = document.createElement('img');
    img.getBoundingClientRect = rect(10, 20, 64, 32) as unknown as () => DOMRect;
    const doc = {
      contentType: 'image/png',
      documentElement: document.createElement('html'),
      head: document.createElement('head'),
      URL: 'http://localhost/api/storage/pic.png',
      querySelector: (sel: string) => (sel === 'img' ? img : null),
    };
    expect(frameImageOf(frame({ doc }))).toEqual({
      contentType: 'image/png',
      src: 'http://localhost/api/storage/pic.png',
      box: { x: 10, y: 20, width: 64, height: 32 },
    });
  });

  it('never treats a readable non-image document as an image, whatever its URL', () => {
    const doc = { contentType: 'text/html', head: {}, URL: 'x', querySelector: () => null };
    expect(frameImageOf(frame({ doc, src: 'http://localhost/api/storage/a.svg' }))).toBeNull();
  });

  it('judges an unreadable document by its URL extension', () => {
    expect(frameImageOf(frame({ src: 'https://example.com/x/logo.SVG?v=2' }))).toEqual({
      contentType: 'image/svg+xml',
      src: 'https://example.com/x/logo.SVG?v=2',
    });
    expect(frameImageOf(frame({ src: 'https://example.com/photo.jpeg' }))?.contentType).toBe(
      'image/jpeg',
    );
    expect(frameImageOf(frame({ src: 'https://example.com/page.html' }))).toBeNull();
    expect(frameImageOf(frame({}))).toBeNull();
  });
});

describe('handlerlessDocumentType', () => {
  it('names a readable document with no <head>', () => {
    const doc = { contentType: 'application/xml', head: null };
    expect(handlerlessDocumentType(frame({ doc }))).toBe('application/xml');
  });

  it('is null for an HTML document or one it cannot read', () => {
    expect(handlerlessDocumentType(frame({ doc: { contentType: 'text/html', head: {} } }))).toBe(
      null,
    );
    expect(handlerlessDocumentType(frame({}))).toBeNull();
  });
});

describe('fitImageBox', () => {
  it('fills the frame for an image with no intrinsic size', () => {
    expect(fitImageBox(0, 0, 800, 600)).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });
  it('keeps a smaller image at its own size', () => {
    expect(fitImageBox(100, 50, 800, 600)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });
  it('shrinks a larger image to fit, keeping its aspect', () => {
    expect(fitImageBox(1600, 600, 800, 600)).toEqual({ x: 0, y: 0, width: 800, height: 300 });
  });
});

function fakeDeps(opts: { loads?: boolean; taints?: boolean; natural?: [number, number] } = {}) {
  const drawn: number[][] = [];
  const sizes: [number, number][] = [];
  const deps: ImageCaptureDeps = {
    loadImage: async () =>
      opts.loads === false
        ? null
        : ({
            naturalWidth: opts.natural?.[0] ?? 0,
            naturalHeight: opts.natural?.[1] ?? 0,
          } as unknown as HTMLImageElement),
    createCanvas: (w, h) => {
      sizes.push([w, h]);
      return {
        getContext: () => ({
          drawImage: (_img: unknown, ...box: number[]) => void drawn.push(box),
        }),
        toDataURL: () => {
          if (opts.taints) throw new Error('SecurityError');
          return 'data:image/webp;base64,AAA';
        },
      } as unknown as HTMLCanvasElement;
    },
  };
  return { deps, drawn, sizes };
}

describe('captureFrameImage', () => {
  const scale = captureScale(800, 600);

  it("draws the image at its shown box, at the capture's scale", async () => {
    const { deps, drawn, sizes } = fakeDeps();
    const result = await captureFrameImage(
      frame({}),
      { contentType: 'image/svg+xml', src: 'data:', box: { x: 5, y: 0, width: 200, height: 100 } },
      deps,
    );
    expect(result).toEqual({ imageData: 'data:image/webp;base64,AAA' });
    expect(sizes).toEqual([[Math.round(800 * scale), Math.round(600 * scale)]]);
    expect(drawn).toEqual([[5 * scale, 0, 200 * scale, 100 * scale]]);
  });

  it('fits an image whose box is unknown', async () => {
    const { deps, drawn } = fakeDeps({ natural: [1600, 1200] });
    await captureFrameImage(frame({}), { contentType: 'image/png', src: 'u' }, deps);
    expect(drawn).toEqual([[0, 0, 800 * scale, 600 * scale]]);
  });

  it('names an image that would not load', async () => {
    const { deps } = fakeDeps({ loads: false });
    const result = await captureFrameImage(frame({}), { contentType: 'image/png', src: 'u' }, deps);
    expect(result.reason).toBe('img-load-error');
    expect(result.detail).toContain('image/png');
  });

  it('names a tainted canvas', async () => {
    const { deps } = fakeDeps({ taints: true });
    const result = await captureFrameImage(frame({}), { contentType: 'image/png', src: 'u' }, deps);
    expect(result.reason).toBe('taint');
  });

  it('refuses a frame with no box', async () => {
    const { deps } = fakeDeps();
    const result = await captureFrameImage(
      frame({ width: 0 }),
      { contentType: 'image/png', src: 'u' },
      deps,
    );
    expect(result.reason).toBe('zero-size');
  });
});

describe('captureIframe — a document with no capture handler', () => {
  it('reports no-capture-handler with the type, not a bare no-response', async () => {
    const doc = { contentType: 'application/xml', head: null };
    const result = await captureIframe(frame({ doc }), 10);
    expect(result.reason).toBe('no-capture-handler (application/xml)');
    expect(result.detail).toContain('retrying will not help');
  });

  it('keeps no-response for an HTML document that simply did not answer', async () => {
    const doc = { contentType: 'text/html', head: {} };
    const result = await captureIframe(frame({ doc }), 10);
    expect(result.reason).toBe('no-response');
  });
});
