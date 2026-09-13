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

function getPoppler(binDir?: string): Poppler {
  const key = binDir ?? '';
  let instance = popplerInstances.get(key);
  if (!instance) {
    instance = new Poppler(binDir);
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
 * Convert pages of a PDF to images. Without a range, converts the whole document.
 * Page numbers on the results reflect the real 1-based page index, not the array position.
 *
 * Poppler rasterizes to PNG; each page is then re-encoded to WebP, because the caller
 * is base64-ing these into a model context and a scanned multi-page PDF is the largest
 * single payload the storage API produces. Pass `raw` to keep poppler's PNG bytes —
 * for a caller that wants the pixels rather than a look at them.
 */
export async function pdfToImages(
  pdfPath: string,
  scale: number = 1.5,
  range?: PdfPageRange,
  opts?: PopplerOptions & { raw?: boolean },
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
  scale: number = 1.5,
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
