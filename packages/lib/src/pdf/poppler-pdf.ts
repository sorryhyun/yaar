/**
 * PDF rendering using node-poppler.
 *
 * This module replaces pdf-to-img + sharp with node-poppler for better
 * compatibility with Bun's --compile bundling.
 */

import { Poppler } from 'node-poppler';
import { join } from 'path';
import { tmpdir } from 'os';
import { readdir, rm, mkdir } from 'fs/promises';
import { toWebPForModel } from '../image.js';

/**
 * Where this installation keeps its `pdftocairo`/`pdftotext`/`pdfinfo` binaries.
 *
 * Omit it and node-poppler auto-detects from PATH, which is what a source checkout
 * wants. A build that ships its own copy of poppler has to say so — and only the host
 * application knows whether it is such a build, which is why this is a parameter
 * rather than something this module works out for itself.
 */
export interface PopplerOptions {
  binDir?: string;
}

// Lazy-initialized poppler instances, one per bin directory. Keyed rather than a single
// singleton so that two callers disagreeing about `binDir` get two Popplers instead of
// whichever one asked first winning for the life of the process.
const popplerInstances = new Map<string, Poppler>();

/**
 * Poppler is not on this machine.
 *
 * node-poppler says so from its constructor, as "Unable to find android Poppler
 * binaries, please pass the installation directory as a parameter to the Poppler
 * instance" — accurate, and no help to whoever is looking at a PDF that will not
 * open: the fix is a package to install, not a parameter to pass. Typed so a caller
 * can tell "nothing here can render a PDF" from "this PDF is broken" and say which.
 */
export class PopplerNotInstalledError extends Error {
  constructor() {
    super(`PDF rendering needs poppler, which is not installed. ${popplerInstallHint()}`);
    this.name = 'PopplerNotInstalledError';
  }
}

/** The one command that installs poppler here. Android first: Termux reports `android`. */
function popplerInstallHint(): string {
  switch (process.platform as string) {
    case 'android':
      return 'In Termux: pkg install poppler';
    case 'darwin':
      return 'Install it with: brew install poppler';
    case 'win32':
      return 'Install poppler and put its bin folder on PATH.';
    default:
      return 'Install it with your package manager, e.g. apt install poppler-utils';
  }
}

function getPoppler(binDir?: string): Poppler {
  const key = binDir ?? '';
  let instance = popplerInstances.get(key);
  if (!instance) {
    // Asked here rather than left to node-poppler, whose own PATH probe shells out to
    // `which` and answers a missing binary with whatever that happened to produce.
    // Windows is excepted: there it falls back to an optional package, not to PATH.
    // A failure is never cached, so installing poppler takes effect without a restart.
    if (
      !binDir &&
      process.platform !== 'win32' &&
      !Bun.which('pdfinfo', { PATH: process.env.PATH })
    ) {
      throw new PopplerNotInstalledError();
    }
    try {
      instance = new Poppler(binDir);
    } catch (err) {
      if (err instanceof Error && /Unable to find .* Poppler binaries/i.test(err.message)) {
        throw new PopplerNotInstalledError();
      }
      throw err;
    }
    popplerInstances.set(key, instance);
  }
  return instance;
}

/**
 * PDF page image result.
 *
 * `mimeType` is whatever the page ended up encoded as — WebP for the model-bound
 * default, PNG when `raw` was asked for or when the re-encode declined. Read it;
 * do not assume either.
 */
export interface PdfPageImage {
  pageNumber: number;
  data: Buffer;
  mimeType: string;
}

/** Page range to rasterize (1-based, inclusive). Omit fields to default to the whole document. */
export interface PdfPageRange {
  firstPage?: number;
  lastPage?: number;
}

/**
 * Raster scale bounds (1 = 72 DPI). The ceiling is what a phone needs to keep a zoomed
 * page sharp, or a model to read dense notation; past it one page is tens of megabytes
 * of bitmap for whoever asked.
 */
export const PDF_SCALE_MIN = 0.5;
export const PDF_SCALE_MAX = 4;
export const PDF_SCALE_DEFAULT = 1.5;

/**
 * A region of a page, each field a fraction of the page's rendered width or height,
 * measured from the top-left corner. `{ x: 0, y: 0.5, w: 1, h: 0.5 }` is the bottom half.
 */
export interface PdfCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Why `crop` is not a region of a page, or null when it is one. Validated here rather
 * than by a schema because apps hand read options over as a plain object.
 */
export function pdfCropError(crop: PdfCrop): string | null {
  const { x, y, w, h } = crop;
  if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return 'pdfCrop needs numeric x, y, w, h (fractions of the page, 0-1)';
  }
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) {
    return 'pdfCrop must lie within the page: x, y >= 0, w, h > 0, x + w <= 1, y + h <= 1';
  }
  return null;
}

/**
 * Size in points of `page` as it renders — width and height swapped for a page rotated
 * a quarter turn, since pdftocairo applies the rotation and crops in output pixels.
 */
async function renderedPageSize(
  poppler: Poppler,
  pdfPath: string,
  page: number,
): Promise<{ width: number; height: number }> {
  const info = await poppler.pdfInfo(pdfPath, {
    firstPageToConvert: page,
    lastPageToConvert: page,
  });
  const infoStr = typeof info === 'string' ? info : JSON.stringify(info);
  const size = infoStr.match(/Page(?:\s+\d+)?\s+size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/i);
  if (!size) throw new Error(`Could not read the size of page ${page}`);
  const rot = parseInt(infoStr.match(/Page(?:\s+\d+)?\s+rot:\s*(\d+)/i)?.[1] ?? '0', 10);
  const [width, height] = [parseFloat(size[1]), parseFloat(size[2])];
  return rot % 180 === 90 ? { width: height, height: width } : { width, height };
}

/**
 * Convert pages of a PDF to images. Without a range, converts the whole document.
 * Page numbers on the results reflect the real 1-based page index, not the array position.
 *
 * Poppler rasterizes to PNG; each page is then re-encoded to WebP, because the caller
 * is base64-ing these into a model context and a scanned multi-page PDF is the largest
 * single payload the storage API produces. Pass `raw` to keep poppler's PNG bytes —
 * for a caller that wants the pixels rather than a look at them.
 *
 * `crop` renders only that region of each page — poppler skips the rest, so a high
 * `scale` on a small region costs what the region costs. The pixel box is measured on
 * the range's first page and applied to every page in it.
 */
export async function pdfToImages(
  pdfPath: string,
  scale: number = PDF_SCALE_DEFAULT,
  range?: PdfPageRange,
  opts?: PopplerOptions & { raw?: boolean; crop?: PdfCrop },
): Promise<PdfPageImage[]> {
  const poppler = getPoppler(opts?.binDir);
  const images: PdfPageImage[] = [];

  const tempDir = join(tmpdir(), `yaar-pdf-${crypto.randomUUID()}`);
  await mkdir(tempDir, { recursive: true });

  try {
    // Convert PDF to PNG files
    // Resolution: 72 DPI * scale (1.5 = 108 DPI)
    const resolution = Math.round(72 * scale);
    const outputPrefix = join(tempDir, 'page');

    const options: Record<string, unknown> = {
      pngFile: true,
      resolutionXYAxis: resolution,
    };
    if (range?.firstPage !== undefined) options.firstPageToConvert = range.firstPage;
    if (range?.lastPage !== undefined) options.lastPageToConvert = range.lastPage;
    if (opts?.crop) {
      const page = await renderedPageSize(poppler, pdfPath, range?.firstPage ?? 1);
      const px = (fraction: number, points: number) =>
        Math.round((fraction * points * resolution) / 72);
      options.cropXAxis = px(opts.crop.x, page.width);
      options.cropYAxis = px(opts.crop.y, page.height);
      options.cropWidth = Math.max(1, px(opts.crop.w, page.width));
      options.cropHeight = Math.max(1, px(opts.crop.h, page.height));
    }

    await poppler.pdfToCairo(pdfPath, outputPrefix, options);

    // Read all generated PNG files. Poppler names each file `page-<realPageNumber>.png`,
    // so parse the true page index from the filename rather than the array position —
    // otherwise a range starting past page 1 would be mislabeled.
    const files = await readdir(tempDir);
    const pngFiles = files
      .filter((f) => f.endsWith('.png'))
      .map((f) => ({ file: f, page: parseInt(f.match(/-(\d+)\.png$/)?.[1] || '0', 10) }))
      .sort((a, b) => a.page - b.page);

    for (const { file, page } of pngFiles) {
      const filePath = join(tempDir, file);
      const png = Buffer.from(await Bun.file(filePath).arrayBuffer());
      const encoded = opts?.raw
        ? { data: png, mimeType: 'image/png' }
        : await toWebPForModel(png, 'image/png');
      images.push({
        pageNumber: page,
        data: encoded.data,
        mimeType: encoded.mimeType,
      });
    }

    return images;
  } finally {
    // Cleanup temp directory
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Render a single PDF page to PNG.
 */
export async function renderPdfPage(
  pdfPath: string,
  pageNumber: number,
  scale: number = PDF_SCALE_DEFAULT,
  opts?: PopplerOptions,
): Promise<Buffer> {
  const poppler = getPoppler(opts?.binDir);

  const tempDir = join(tmpdir(), `yaar-pdf-${crypto.randomUUID()}`);
  await mkdir(tempDir, { recursive: true });

  try {
    const resolution = Math.round(72 * scale);
    const outputPrefix = join(tempDir, 'page');

    await poppler.pdfToCairo(pdfPath, outputPrefix, {
      pngFile: true,
      singleFile: true,
      firstPageToConvert: pageNumber,
      lastPageToConvert: pageNumber,
      resolutionXYAxis: resolution,
    });

    // Read the generated PNG file
    const files = await readdir(tempDir);
    const pngFile = files.find((f) => f.endsWith('.png'));

    if (!pngFile) {
      throw new Error(`Failed to render page ${pageNumber}`);
    }

    return Buffer.from(await Bun.file(join(tempDir, pngFile)).arrayBuffer());
  } finally {
    // Cleanup temp directory
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Extract the text layer of a PDF (via pdftotext). Without a range, extracts the whole document.
 * Returns an empty string for scanned/image-only PDFs that carry no text layer.
 */
export async function pdfToText(
  pdfPath: string,
  range?: PdfPageRange,
  opts?: PopplerOptions,
): Promise<string> {
  const poppler = getPoppler(opts?.binDir);
  const options: Record<string, unknown> = {};
  if (range?.firstPage !== undefined) options.firstPageToConvert = range.firstPage;
  if (range?.lastPage !== undefined) options.lastPageToConvert = range.lastPage;
  // No outputFile → node-poppler resolves with the extracted text on stdout.
  const out = await poppler.pdfToText(pdfPath, undefined, options);
  return typeof out === 'string' ? out : '';
}

/** What a viewer needs before it has drawn anything: how many pages, and how big. */
export interface PdfInfo {
  pages: number;
  /** The first page's size in points. Absent when pdfinfo did not report one. */
  pageSize?: { width: number; height: number };
}

/**
 * Page count and first-page size of a PDF. Unlike {@link getPdfPageCount} this throws
 * when poppler cannot read the file — its caller is about to render pages and needs the
 * reason, not a zero.
 */
export async function getPdfInfo(pdfPath: string, opts?: PopplerOptions): Promise<PdfInfo> {
  const poppler = getPoppler(opts?.binDir);
  const info = await poppler.pdfInfo(pdfPath);
  const infoStr = typeof info === 'string' ? info : JSON.stringify(info);
  const pages = parseInt(infoStr.match(/Pages:\s*(\d+)/i)?.[1] ?? '', 10);
  if (!Number.isFinite(pages) || pages < 1) throw new Error('PDF has no readable pages');
  const size = infoStr.match(/Page size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/i);
  const width = size ? parseFloat(size[1]) : NaN;
  const height = size ? parseFloat(size[2]) : NaN;
  return {
    pages,
    ...(width > 0 && height > 0 ? { pageSize: { width, height } } : {}),
  };
}

/**
 * Get the number of pages in a PDF.
 */
export async function getPdfPageCount(pdfPath: string, opts?: PopplerOptions): Promise<number> {
  const poppler = getPoppler(opts?.binDir);

  try {
    const info = await poppler.pdfInfo(pdfPath);
    // pdfInfo returns a string or object, handle both
    const infoStr = typeof info === 'string' ? info : JSON.stringify(info);
    const match = infoStr.match(/Pages:\s*(\d+)/i);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}
