/**
 * Showing a stored PDF where the browser cannot.
 *
 * An iframe pointed at a PDF renders only where the browser ships an inline viewer.
 * Desktop Chrome, Firefox and Safari do; Chrome on Android does not, and a frame there
 * simply stays white — no error, no load failure, nothing to detect from outside. The
 * server can already rasterize a stored PDF a page at a time (`/api/pdf/{path}/{page}`),
 * so on such a browser the window shows those pages instead of the frame.
 *
 * Only a file in storage has that route. A PDF on someone else's site is still handed
 * to the iframe as before.
 */

/**
 * Whether an `<iframe src="….pdf">` renders here. `navigator.pdfViewerEnabled` is the
 * browser's own answer; a browser too old to have the property keeps the frame, which
 * is what it had before.
 */
export function hasInlinePdfViewer(): boolean {
  return navigator.pdfViewerEnabled !== false;
}

export interface PdfInfo {
  pages: number;
  /** First page, in points. */
  pageSize?: { width: number; height: number };
}

/** A stored PDF, addressed through the rasterizer rather than as a file. */
export interface StoragePdf {
  /** `GET` → {@link PdfInfo}. */
  infoUrl: string;
  /** One page as a PNG, `scale` × 72 DPI. */
  pageUrl(page: number, scale: number): string;
}

const STORAGE_PREFIX = '/api/storage/';

/**
 * The rasterizer's URLs for a storage file URL, or null when `url` is not a stored PDF.
 *
 * The query string is carried over whole: it holds the window's iframe token (and the
 * remote token), so the pages are fetched as the same principal the frame would have
 * been — a window that could not have loaded the file cannot have it drawn either.
 * The caller vouches for the origin; a path alone says nothing about whose server it is.
 */
export function storagePdf(url: string): StoragePdf | null {
  let parsed: URL;
  try {
    parsed = new URL(url, window.location.origin);
  } catch {
    return null;
  }
  if (!parsed.pathname.startsWith(STORAGE_PREFIX)) return null;
  if (!/\.pdf$/i.test(parsed.pathname)) return null;

  const file = parsed.pathname.slice(STORAGE_PREFIX.length);
  const relative = url.startsWith('/');
  const at = (suffix: string, scale?: number) => {
    const u = new URL(parsed.href);
    u.pathname = `/api/pdf/${file}${suffix}`;
    if (scale !== undefined) u.searchParams.set('scale', String(scale));
    return relative ? u.pathname + u.search : u.href;
  };
  return {
    infoUrl: at(''),
    pageUrl: (page, scale) => at(`/${page}`, scale),
  };
}

/** The scales pages are asked for. A handful, so a resize or a zoom step reuses a raster. */
const RASTER_SCALES = [1.5, 2, 3, 4];

/** Used until the server says how wide the page is: US Letter, in points. */
export const FALLBACK_PAGE_SIZE = { width: 612, height: 792 };

/**
 * The smallest raster that covers a page drawn `cssWidth` wide on this screen, or the
 * largest the server offers when none does.
 */
export function rasterScale(cssWidth: number, devicePixelRatio: number, pageWidthPts: number) {
  const needed = (cssWidth * devicePixelRatio) / pageWidthPts;
  return RASTER_SCALES.find((s) => s >= needed) ?? RASTER_SCALES[RASTER_SCALES.length - 1];
}

/** Ask the server how many pages there are. Rejects with the server's own sentence. */
export async function fetchPdfInfo(infoUrl: string, signal?: AbortSignal): Promise<PdfInfo> {
  const res = await fetch(infoUrl, { signal });
  const body = (await res.json().catch(() => null)) as (PdfInfo & { error?: string }) | null;
  if (!res.ok || !body || typeof body.pages !== 'number') {
    throw new Error(body?.error ?? `Could not read the PDF (HTTP ${res.status})`);
  }
  return body;
}
