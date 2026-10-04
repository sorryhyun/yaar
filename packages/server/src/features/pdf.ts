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
  getPdfInfo as libGetPdfInfo,
  getPdfPageCount as libGetPdfPageCount,
  pdfToImages as libPdfToImages,
  pdfToText as libPdfToText,
  renderPdfPage as libRenderPdfPage,
  type PdfCrop,
  type PdfInfo,
  type PdfPageImage,
  type PdfPageRange,
} from '@yaar/lib/pdf';
import { getPopplerBinDir } from '../config.js';

export {
  PopplerNotInstalledError,
  PDF_SCALE_DEFAULT,
  PDF_SCALE_MAX,
  PDF_SCALE_MIN,
  pdfCropError,
} from '@yaar/lib/pdf';
export type { PdfCrop, PdfInfo, PdfPageImage, PdfPageRange };

/** Convert pages of a PDF to images. Without a range, converts the whole document. */
export function pdfToImages(
  pdfPath: string,
  scale?: number,
  range?: PdfPageRange,
  opts?: { raw?: boolean; crop?: PdfCrop },
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

/** Page count and first-page size. Throws when poppler is missing or cannot read the file. */
export function getPdfInfo(pdfPath: string): Promise<PdfInfo> {
  return libGetPdfInfo(pdfPath, { binDir: getPopplerBinDir() });
}
