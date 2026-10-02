/**
 * A stored PDF in an iframe window, on a browser that cannot draw a PDF in a frame.
 *
 * Chrome on Android ships no inline PDF viewer, so `<iframe src="….pdf">` there loads
 * nothing: a white window, a `load` event, and no error anywhere (GitHub issue #150).
 * The window now shows the server's page rasters instead — but only there. A browser
 * that *has* a viewer must keep the frame, which is the better reader wherever it works.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import { MemoizedIframeRenderer } from '@/components/window/renderers/IframeRenderer';
import { rasterScale, storagePdf } from '@/lib/pdfPages';

const PDF_URL = '/api/storage/shared/browser/downloads/2609.29142v2.pdf';

function setUrl(url: string): void {
  (window as unknown as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(url);
}

/** What the browser says about itself. `undefined` removes the property again. */
function setPdfViewer(enabled: boolean | undefined) {
  Object.defineProperty(navigator, 'pdfViewerEnabled', { configurable: true, value: enabled });
}

const originalFetch = globalThis.fetch;
const originalHref = window.location.href;
let requested: string[] = [];

function answerInfo(body: unknown, status = 200) {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return Response.json(body, { status });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  requested = [];
  setUrl('http://localhost:8000/');
  useDesktopStore.setState({ sessionId: 'sess-1', notifications: {} });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  setPdfViewer(undefined);
  setUrl(originalHref);
});

describe('storagePdf', () => {
  it('maps a storage URL onto the rasterizer and keeps the credentials', () => {
    const pdf = storagePdf(`${PDF_URL}?sessionId=sess-1&__yaar_token=tok-1`);
    expect(pdf?.infoUrl).toBe(
      '/api/pdf/shared/browser/downloads/2609.29142v2.pdf?sessionId=sess-1&__yaar_token=tok-1',
    );
    expect(pdf?.pageUrl(3, 2)).toBe(
      '/api/pdf/shared/browser/downloads/2609.29142v2.pdf/3?sessionId=sess-1&__yaar_token=tok-1&scale=2',
    );
  });

  it('keeps an absolute URL absolute', () => {
    const pdf = storagePdf('http://localhost:8000/api/storage/a%20b.PDF?token=t');
    expect(pdf?.pageUrl(1, 1.5)).toBe(
      'http://localhost:8000/api/pdf/a%20b.PDF/1?token=t&scale=1.5',
    );
  });

  it('is null for anything that is not a stored PDF', () => {
    expect(storagePdf('/api/storage/notes/plan.md')).toBeNull();
    expect(storagePdf('/api/apps/reader/manual.pdf')).toBeNull();
    expect(storagePdf('/api/storage/shared?list=true&name=x.pdf')).toBeNull();
  });
});

describe('rasterScale', () => {
  it('covers the device pixels, in a few fixed steps', () => {
    expect(rasterScale(360, 1, 612)).toBe(1.5);
    expect(rasterScale(360, 3, 612)).toBe(2); // 1080 device px over a 612pt page
    expect(rasterScale(720, 3, 612)).toBe(4);
    expect(rasterScale(2000, 3, 612)).toBe(4); // capped at what the server offers
  });
});

describe('IframeRenderer with a stored PDF', () => {
  it('keeps the frame where the browser has a PDF viewer', () => {
    setPdfViewer(true);
    answerInfo({ pages: 3 });
    const { container } = render(<MemoizedIframeRenderer data={PDF_URL} />);
    expect(container.querySelector('iframe')?.getAttribute('src')).toContain(PDF_URL);
    expect(requested).toEqual([]);
  });

  it('draws the pages where it has none', async () => {
    setPdfViewer(false);
    answerInfo({ pages: 3, pageSize: { width: 595, height: 842 } });
    const onRenderSuccess = mock(() => {});
    const { container } = render(
      <MemoizedIframeRenderer
        data={PDF_URL}
        iframeToken="tok-1"
        requestId="req-1"
        onRenderSuccess={onRenderSuccess}
      />,
    );

    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(3));
    expect(container.querySelector('iframe')).toBeNull();

    // Asked as the window, not as the desktop: the token rides along.
    expect(requested).toHaveLength(1);
    expect(requested[0]).toStartWith('/api/pdf/shared/browser/downloads/2609.29142v2.pdf?');
    expect(requested[0]).toContain('__yaar_token=tok-1');

    const pages = [...container.querySelectorAll('img')];
    expect(pages[1].getAttribute('src')).toStartWith(
      '/api/pdf/shared/browser/downloads/2609.29142v2.pdf/2?',
    );
    expect(pages[1].getAttribute('src')).toContain('__yaar_token=tok-1');
    // Shaped before it loads, so the lazy pages below stay below.
    expect(pages[1].getAttribute('loading')).toBe('lazy');
    expect(pages[1].getAttribute('width')).toBe('595');
    expect(pages[1].getAttribute('height')).toBe('842');

    expect(onRenderSuccess).toHaveBeenCalledTimes(1);
  });

  it('zooms in steps and asks for a sharper raster', async () => {
    setPdfViewer(false);
    answerInfo({ pages: 1 });
    const { container } = render(<MemoizedIframeRenderer data={PDF_URL} />);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());

    const scaleOf = () =>
      Number(new URL(container.querySelector('img')!.src, 'http://x').searchParams.get('scale'));
    const before = scaleOf();
    expect((screen.getByLabelText('Zoom out') as HTMLButtonElement).disabled).toBe(true);

    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(screen.getByText('300%')).toBeTruthy();
    expect((screen.getByLabelText('Zoom in') as HTMLButtonElement).disabled).toBe(true);
    expect(scaleOf()).toBeGreaterThan(before);
  });

  it("says why when the server cannot render it, in the server's words", async () => {
    setPdfViewer(false);
    answerInfo(
      {
        error:
          'PDF rendering needs poppler, which is not installed. In Termux: pkg install poppler',
      },
      501,
    );
    const onRenderError = mock((_error: string, _url: string) => {});
    const { container } = render(
      <MemoizedIframeRenderer data={PDF_URL} requestId="req-1" onRenderError={onRenderError} />,
    );

    await waitFor(() => expect(screen.getByText('Cannot show this PDF')).toBeTruthy());
    expect(screen.getByText(/pkg install poppler/)).toBeTruthy();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).toContain(PDF_URL);
    expect(onRenderError).toHaveBeenCalledTimes(1);
    expect(onRenderError.mock.calls[0][0]).toContain('poppler');
  });

  it('leaves a PDF on another site to the frame', () => {
    setPdfViewer(false);
    answerInfo({ pages: 3 });
    const { container } = render(<MemoizedIframeRenderer data="https://example.com/paper.pdf" />);
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(
      'https://example.com/paper.pdf',
    );
    expect(requested).toEqual([]);
  });
});
