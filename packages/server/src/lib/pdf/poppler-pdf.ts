/**
 * PDF rendering using node-poppler.
 *
 * This module replaces pdf-to-img + sharp with node-poppler for better
 * compatibility with Bun's --compile bundling.
 */

import { Poppler } from 'node-poppler';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { readdir, rm, mkdir } from 'fs/promises';
import { IS_BUNDLED_EXE } from '../../config.js';

/**
 * Get the path to poppler binaries.
 * - Bundled exe: ./poppler/ alongside the executable
 * - Development: undefined (uses node-poppler's auto-detection)
 */
function getPopplerPath(): string | undefined {
  if (IS_BUNDLED_EXE) {
    return join(dirname(process.execPath), 'poppler');
  }
  return undefined;
}

// Lazy-initialized poppler instance
let popplerInstance: Poppler | null = null;

function getPoppler(): Poppler {
  if (!popplerInstance) {
    popplerInstance = new Poppler(getPopplerPath());
  }
  return popplerInstance;
}

/**
 * PDF page image result.
 */
export interface PdfPageImage {
  pageNumber: number;
  data: Buffer;
  mimeType: 'image/png';
}

/** Page range to rasterize (1-based, inclusive). Omit fields to default to the whole document. */
export interface PdfPageRange {
  firstPage?: number;
  lastPage?: number;
}

/**
 * Convert pages of a PDF to PNG images. Without a range, converts the whole document.
 * Page numbers on the results reflect the real 1-based page index, not the array position.
 */
export async function pdfToImages(
  pdfPath: string,
  scale: number = 1.5,
  range?: PdfPageRange,
): Promise<PdfPageImage[]> {
  const poppler = getPoppler();
  const images: PdfPageImage[] = [];

  // Create a unique temp directory for this conversion
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
      const data = Buffer.from(await Bun.file(filePath).arrayBuffer());
      images.push({
        pageNumber: page,
        data,
        mimeType: 'image/png',
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
): Promise<Buffer> {
  const poppler = getPoppler();

  // Create a unique temp directory for this conversion
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
export async function pdfToText(pdfPath: string, range?: PdfPageRange): Promise<string> {
  const poppler = getPoppler();
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
export async function getPdfPageCount(pdfPath: string): Promise<number> {
  const poppler = getPoppler();

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
