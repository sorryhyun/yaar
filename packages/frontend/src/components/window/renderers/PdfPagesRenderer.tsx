/**
 * PdfPagesRenderer - A stored PDF as a column of server-rasterized pages.
 *
 * Stands in for the iframe on a browser with no inline PDF viewer (see `lib/pdfPages`).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  FALLBACK_PAGE_SIZE,
  fetchPdfInfo,
  rasterScale,
  type PdfInfo,
  type StoragePdf,
} from '@/lib/pdfPages';
import styles from '@/styles/window/renderers.module.css';

interface PdfPagesRendererProps {
  pdf: StoragePdf;
  /** The file itself, for the way out: a top-level navigation is what a phone can open. */
  fileUrl: string;
  onRenderSuccess?: () => void;
  onRenderError?: (error: string) => void;
}

/** Fit-width first; the rest is what it takes to read a two-column page on a phone. */
const ZOOM_STEPS = [1, 1.5, 2, 3];

export function PdfPagesRenderer({
  pdf,
  fileUrl,
  onRenderSuccess,
  onRenderError,
}: PdfPagesRendererProps) {
  const [info, setInfo] = useState<PdfInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomStep, setZoomStep] = useState(0);
  const [fitWidth, setFitWidth] = useState(() => window.innerWidth);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // The callbacks answer the server's one pending render request; a parent re-render
  // must not re-run the fetch to deliver them again.
  const callbacks = useRef({ onRenderSuccess, onRenderError });
  callbacks.current = { onRenderSuccess, onRenderError };

  const { infoUrl } = pdf;
  useEffect(() => {
    const abort = new AbortController();
    setInfo(null);
    setError(null);
    fetchPdfInfo(infoUrl, abort.signal).then(
      (result) => {
        setInfo(result);
        callbacks.current.onRenderSuccess?.();
      },
      (err: unknown) => {
        if (abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : 'Could not read the PDF';
        setError(message);
        callbacks.current.onRenderError?.(message);
      },
    );
    return () => abort.abort();
  }, [infoUrl]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (scroller.clientWidth > 0) setFitWidth(scroller.clientWidth);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [info]);

  // Where the middle of the view sat in the document before a zoom step, as fractions.
  // Without it the scroll offsets stay put in pixels while the pages grow under them,
  // and zooming in on page 9 lands on page 5.
  const zoomAnchor = useRef<{ x: number; y: number } | null>(null);
  const stepZoom = (delta: number) => {
    const scroller = scrollerRef.current;
    if (scroller && scroller.scrollHeight > 0 && scroller.scrollWidth > 0) {
      zoomAnchor.current = {
        x: (scroller.scrollLeft + scroller.clientWidth / 2) / scroller.scrollWidth,
        y: (scroller.scrollTop + scroller.clientHeight / 2) / scroller.scrollHeight,
      };
    }
    setZoomStep((s) => Math.min(ZOOM_STEPS.length - 1, Math.max(0, s + delta)));
  };
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    if (!scroller || !anchor) return;
    scroller.scrollLeft = anchor.x * scroller.scrollWidth - scroller.clientWidth / 2;
    scroller.scrollTop = anchor.y * scroller.scrollHeight - scroller.clientHeight / 2;
  }, [zoomStep]);

  if (error) {
    return (
      <div className={styles.iframeError}>
        <div className={styles.iframeErrorIcon}>📄</div>
        <div className={styles.iframeErrorTitle}>Cannot show this PDF</div>
        <div className={styles.iframeErrorMessage}>{error}</div>
        <a
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.iframeErrorLink}
        >
          Open in new tab →
        </a>
      </div>
    );
  }

  if (!info) {
    return (
      <div className={styles.iframeContainer}>
        <div className={styles.iframeLoading}>
          <div className={styles.iframeLoadingSpinner} />
          <span>Loading…</span>
        </div>
      </div>
    );
  }

  const zoom = ZOOM_STEPS[zoomStep];
  const size = info.pageSize ?? FALLBACK_PAGE_SIZE;
  const scale = rasterScale(fitWidth * zoom, window.devicePixelRatio || 1, size.width);

  return (
    <div className={styles.pdf}>
      <div className={styles.pdfScroller} ref={scrollerRef}>
        <div className={styles.pdfPages} style={{ width: `${zoom * 100}%` }}>
          {Array.from({ length: info.pages }, (_, i) => i + 1).map((page) => (
            // width/height give the box its shape before the raster arrives, which is
            // what lets `loading="lazy"` hold back the pages still far below.
            <img
              key={page}
              className={styles.pdfPage}
              src={pdf.pageUrl(page, scale)}
              width={size.width}
              height={size.height}
              loading="lazy"
              decoding="async"
              draggable={false}
              alt={`Page ${page}`}
            />
          ))}
        </div>
      </div>
      <div className={styles.pdfToolbar}>
        <button
          type="button"
          className={styles.pdfToolbarButton}
          aria-label="Zoom out"
          disabled={zoomStep === 0}
          onClick={() => stepZoom(-1)}
        >
          −
        </button>
        <span className={styles.pdfToolbarLabel}>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className={styles.pdfToolbarButton}
          aria-label="Zoom in"
          disabled={zoomStep === ZOOM_STEPS.length - 1}
          onClick={() => stepZoom(1)}
        >
          +
        </button>
        <span className={styles.pdfToolbarLabel}>
          {info.pages} {info.pages === 1 ? 'page' : 'pages'}
        </span>
        <a
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.pdfToolbarButton}
          aria-label="Open the PDF file"
        >
          ↗
        </a>
      </div>
    </div>
  );
}
