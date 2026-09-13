/**
 * PDF rendering, bound to this installation's poppler binaries.
 *
 * The rendering itself is `@yaar/lib/pdf`, which takes the binary directory as a
 * parameter: it has no way to tell a source checkout from a bundled exe, and that is
 * not its question to answer. This module answers it once, with `getPopplerBinDir()`,
 * so that no call site has to remember — a forgotten `binDir` would silently fall back
 * to a PATH lookup in a build that ships its own poppler, and "silently" is the whole
 * problem with that failure.
 *
 * Import from here, not from `@yaar/lib/pdf`. Same relationship as `features/fonts/`
 * and `@yaar/lib/fonts`: the library knows bytes, the feature knows YAAR.
 */

import {
  getPdfPageCount as libGetPdfPageCount,
  pdfToImages as libPdfToImages,
  pdfToText as libPdfToText,
  renderPdfPage as libRenderPdfPage,
  type PdfPageImage,
  type PdfPageRange,
} from '@yaar/lib/pdf';
import { getPopplerBinDir } from '../config.js';

export type { PdfPageImage, PdfPageRange };

/** Convert pages of a PDF to images. Without a range, converts the whole document. */
export function pdfToImages(
  pdfPath: string,
  scale?: number,
  range?: PdfPageRange,
  opts?: { raw?: boolean },
): Promise<PdfPageImage[]> {
  return libPdfToImages(pdfPath, scale, range, { ...opts, binDir: getPopplerBinDir() });
}

/** Render a single PDF page to PNG. */
export function renderPdfPage(
  pdfPath: string,
  pageNumber: number,
  scale?: number,
): Promise<Buffer> {
  return libRenderPdfPage(pdfPath, pageNumber, scale, { binDir: getPopplerBinDir() });
}

/** Extract the text layer of a PDF. Empty string for a scanned PDF that carries none. */
export function pdfToText(pdfPath: string, range?: PdfPageRange): Promise<string> {
  return libPdfToText(pdfPath, range, { binDir: getPopplerBinDir() });
}

/** Number of pages in a PDF, or 0 if poppler could not read it. */
export function getPdfPageCount(pdfPath: string): Promise<number> {
  return libGetPdfPageCount(pdfPath, { binDir: getPopplerBinDir() });
}
