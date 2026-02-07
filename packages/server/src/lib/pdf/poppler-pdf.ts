/**
 * PDF rendering using node-poppler.
 *
 * This module replaces pdf-to-img + sharp with node-poppler for better
 * compatibility with Bun's --compile bundling.
 */

import { Poppler } from 'node-poppler';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { readdir, readFile, rm, mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';

/**
 * Check if running as a bundled Bun executable.
 */
function isBundledExe(): boolean {
  // Bun sets this when running a compiled executable
  return typeof process.env.BUN_SELF_EXEC !== 'undefined' ||
    process.argv[0]?.endsWith('.exe') ||
    process.argv[0]?.includes('yaar');
}

/**
 * Get the path to poppler binaries.
 * - Bundled exe: ./poppler/ alongside the executable
 * - Development: undefined (uses node-poppler's auto-detection)
 */
function getPopplerPath(): string | undefined {
  if (isBundledExe()) {
    // Bundled exe: binaries in ./poppler/ alongside exe
    return join(dirname(process.execPath), 'poppler');
  }
  // Development: let node-poppler find the binaries
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

/**
 * Convert all pages of a PDF to PNG images.
 */
export async function pdfToImages(pdfPath: string, scale: number = 1.5, maxPages?: number): Promise<PdfPageImage[]> {
  const poppler = getPoppler();
  const images: PdfPageImage[] = [];

  // Create a unique temp directory for this conversion
  const tempDir = join(tmpdir(), `yaar-pdf-${randomUUID()}`);
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
    if (maxPages !== undefined) {
      options.firstPageToConvert = 1;
      options.lastPageToConvert = maxPages;
    }

    await poppler.pdfToCairo(pdfPath, outputPrefix, options);

    // Read all generated PNG files
    const files = await readdir(tempDir);
    const pngFiles = files
      .filter(f => f.endsWith('.png'))
      .sort((a, b) => {
        // Extract page number from filename (e.g., "page-1.png")
        const numA = parseInt(a.match(/-(\d+)\.png$/)?.[1] || '0', 10);
        const numB = parseInt(b.match(/-(\d+)\.png$/)?.[1] || '0', 10);
        return numA - numB;
      });

    for (let i = 0; i < pngFiles.length; i++) {
      const filePath = join(tempDir, pngFiles[i]);
      const data = await readFile(filePath);
      images.push({
        pageNumber: i + 1,
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
  scale: number = 1.5
): Promise<Buffer> {
  const poppler = getPoppler();

  // Create a unique temp directory for this conversion
  const tempDir = join(tmpdir(), `yaar-pdf-${randomUUID()}`);
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
    const pngFile = files.find(f => f.endsWith('.png'));

    if (!pngFile) {
      throw new Error(`Failed to render page ${pageNumber}`);
    }

    return await readFile(join(tempDir, pngFile));
  } finally {
    // Cleanup temp directory
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
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
