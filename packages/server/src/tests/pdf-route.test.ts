/**
 * `/api/pdf/{path}` and `/api/pdf/{path}/{page}` — what a window uses to show a stored
 * PDF on a browser with no inline viewer (GitHub issue #150).
 *
 * The page route alone was not enough to build a viewer on: nothing said how many pages
 * to ask for, the raster was fixed at a size that is soft on a phone's screen, and a
 * machine without poppler answered a bare "Failed to render PDF page".
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { handleFileRoutes } from '../http/routes/files.js';
import { storageDelete, storageWrite } from '../storage/storage-manager.js';

const SCRATCH = `temp/__pdf-route-${process.pid}`;
const PDF = `${SCRATCH}/two pages.pdf`;
const HAS_POPPLER = !!Bun.which('pdfinfo');

/** A valid PDF of blank pages, with a real xref table so poppler has nothing to repair. */
function blankPdf(pages: number, width: number, height: number): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from(
      { length: pages },
      () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] >>`,
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

function get(path: string) {
  const req = new Request(`http://localhost:8000${path}`);
  return handleFileRoutes(req, new URL(req.url));
}

/** Width of a PNG, from its IHDR chunk. */
async function pngWidth(res: Response): Promise<number> {
  return new DataView(await res.arrayBuffer()).getUint32(16);
}

const url = (suffix = '') => `/api/pdf/${encodeURI(PDF)}${suffix}`;

beforeAll(async () => {
  await storageWrite(PDF, blankPdf(2, 200, 300));
  await storageWrite(`${SCRATCH}/notes.txt`, Buffer.from('not a pdf'));
});

afterAll(async () => {
  await storageDelete(SCRATCH);
});

describe('GET /api/pdf/{path}', () => {
  it.skipIf(!HAS_POPPLER)('answers the page count and page size', async () => {
    const res = await get(url());
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ pages: 2, pageSize: { width: 200, height: 300 } });
  });

  it('is 404 for a file that is not there', async () => {
    const res = await get(`/api/pdf/${SCRATCH}/missing.pdf`);
    expect(res?.status).toBe(404);
  });

  it('refuses a file that is not a PDF', async () => {
    const res = await get(`/api/pdf/${SCRATCH}/notes.txt`);
    expect(res?.status).toBe(400);
  });
});

describe('GET /api/pdf/{path}/{page}', () => {
  it.skipIf(!HAS_POPPLER)('renders at 1.5× by default and at ?scale= when asked', async () => {
    const byDefault = await get(url('/1'));
    expect(byDefault?.headers.get('Content-Type')).toBe('image/png');
    expect(await pngWidth(byDefault!)).toBe(300); // 200pt × 1.5

    const sharper = await get(url('/2?scale=3'));
    expect(await pngWidth(sharper!)).toBe(600);
  });

  it('refuses a scale outside the range before rendering anything', async () => {
    for (const scale of ['0', '9', 'big', '']) {
      const res = await get(url(`/1?scale=${scale}`));
      expect(res?.status).toBe(400);
      expect(((await res!.json()) as { error: string }).error).toContain('scale');
    }
  });
});

describe('without poppler', () => {
  // Only on a machine that has none — which is the machine the message is for. The
  // detection itself is covered wherever it runs, in @yaar/lib's pdf-info test.
  it.skipIf(HAS_POPPLER)('says what to install, on both routes', async () => {
    for (const suffix of ['', '/1']) {
      const res = await get(url(suffix));
      expect(res?.status).toBe(501);
      const { error } = (await res!.json()) as { error: string };
      expect(error).toContain('poppler');
      expect(error).toContain('nstall');
    }
  });
});
