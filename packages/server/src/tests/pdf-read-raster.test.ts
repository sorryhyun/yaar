/**
 * `read` with `pdfPages`, `pdfScale` and `pdfCrop` (GitHub issue #156).
 *
 * Pages rasterized at a fixed 1.5× left dense pages — a piano score, ~7 px between staff
 * lines — illegible, with no way to ask for more pixels or for one region of the page.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { storageDelete, storageRead, storageWrite } from '../storage/storage-manager.js';

const SCRATCH = `temp/__pdf-read-raster-${process.pid}`;
const PDF = `${SCRATCH}/five pages.pdf`;
const ROTATED = `${SCRATCH}/rotated.pdf`;
const HAS_POPPLER = !!Bun.which('pdftocairo');

/** A valid PDF of blank pages, with a real xref table so poppler has nothing to repair. */
function blankPdf(pages: number, width: number, height: number, rotate = 0): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from(
      { length: pages },
      () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Rotate ${rotate} >>`,
    ),
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

/** Width and height of each returned page, from the PNG's IHDR chunk. */
async function pageSizes(
  path: string,
  opts: Parameters<typeof storageRead>[1],
): Promise<{ page: number; width: number; height: number }[]> {
  const result = await storageRead(path, { rawImage: true, ...opts });
  expect(result.error).toBeUndefined();
  return (result.images ?? []).map((img) => {
    const view = new DataView(Buffer.from(img.data, 'base64').buffer);
    return { page: img.pageNumber!, width: view.getUint32(16), height: view.getUint32(20) };
  });
}

beforeAll(async () => {
  await storageWrite(PDF, blankPdf(5, 200, 300));
  await storageWrite(ROTATED, blankPdf(1, 200, 300, 90));
});

afterAll(async () => {
  await storageDelete(SCRATCH);
});

describe.skipIf(!HAS_POPPLER)('pdfPages rendering', () => {
  it('renders at 1.5× by default and at pdfScale when asked', async () => {
    expect(await pageSizes(PDF, { pdfPages: '1' })).toEqual([{ page: 1, width: 300, height: 450 }]);
    expect(await pageSizes(PDF, { pdfPages: '2', pdfScale: 3 })).toEqual([
      { page: 2, width: 600, height: 900 },
    ]);
  });

  it('renders only the pdfCrop region, in page fractions', async () => {
    // Top-right quarter-height strip of a 200×300pt page at 2× (400×600 px).
    const sizes = await pageSizes(PDF, {
      pdfPages: '3',
      pdfScale: 2,
      pdfCrop: { x: 0.5, y: 0, w: 0.5, h: 0.25 },
    });
    expect(sizes).toEqual([{ page: 3, width: 200, height: 150 }]);
  });

  it('measures the crop on the page as it renders, rotation applied', async () => {
    // A 200×300pt page rotated 90° renders 300 wide and 200 tall.
    const sizes = await pageSizes(ROTATED, {
      pdfPages: '1',
      pdfScale: 1,
      pdfCrop: { x: 0, y: 0, w: 1, h: 0.5 },
    });
    expect(sizes).toEqual([{ page: 1, width: 300, height: 100 }]);
  });

  it('returns fewer pages per read as each page costs more pixels', async () => {
    const atDefault = await pageSizes(PDF, { pdfPages: '1-5' });
    expect(atDefault.map((p) => p.page)).toEqual([1, 2, 3, 4, 5]);

    // (4 / 1.5)² ≈ 7.1 default pages each → 20 / 7.1 → 2 pages.
    const sharp = await pageSizes(PDF, { pdfPages: '1-5', pdfScale: 4 });
    expect(sharp.map((p) => p.page)).toEqual([1, 2]);

    // The same scale on a quarter of each page buys the pages back.
    const cropped = await pageSizes(PDF, {
      pdfPages: '1-5',
      pdfScale: 4,
      pdfCrop: { x: 0, y: 0, w: 0.5, h: 0.5 },
    });
    expect(cropped.map((p) => p.page)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('pdfPages option validation', () => {
  // Apps hand read options over as a plain object, so the storage layer checks them itself.
  it('refuses a scale outside 0.5-4', async () => {
    for (const pdfScale of [0, 9, Number.NaN, '2' as unknown as number]) {
      const result = await storageRead(PDF, { pdfPages: '1', pdfScale });
      expect(result.success).toBe(false);
      expect(result.error).toContain('pdfScale');
    }
  });

  it('refuses a crop that is not a region of the page', async () => {
    const crops = [
      { x: 0.8, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: 0, h: 1 },
      { x: -0.1, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: 1 },
      'top half',
    ];
    for (const pdfCrop of crops) {
      const result = await storageRead(PDF, {
        pdfPages: '1',
        pdfCrop: pdfCrop as unknown as { x: number; y: number; w: number; h: number },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('pdfCrop');
    }
  });
});
