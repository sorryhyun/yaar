/**
 * `getPdfInfo`, and what a machine without poppler says.
 *
 * node-poppler reports a missing install as "Unable to find android Poppler binaries,
 * please pass the installation directory as a parameter to the Poppler instance" — or,
 * where `which` is missing too, as a TypeError from its own PATH probe. Neither names
 * the fix, and that text was reaching a phone user as "Failed to render PDF page"
 * (GitHub issue #150). The typed error is what lets a caller say "install poppler".
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { getPdfInfo, PopplerNotInstalledError } from '../pdf/poppler-pdf.js';

const HAS_POPPLER = !!Bun.which('pdfinfo');

/** A valid PDF of blank pages, with a real xref table so poppler has nothing to repair. */
function blankPdf(pages: number, width: number, height: number): Uint8Array {
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
  return new TextEncoder().encode(body);
}

describe('getPdfInfo', () => {
  const savedPath = process.env.PATH;
  let dir: string | undefined;

  afterEach(async () => {
    process.env.PATH = savedPath;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('names the missing install instead of passing on node-poppler’s complaint', async () => {
    process.env.PATH = '/nonexistent';
    const failure = await getPdfInfo('/anything.pdf').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(PopplerNotInstalledError);
    expect((failure as Error).message).toContain('poppler');
    expect((failure as Error).message).toContain('nstall');
  });

  it.skipIf(!HAS_POPPLER)('reports the page count and the first page’s size', async () => {
    dir = await mkdtemp(join(tmpdir(), 'yaar-pdf-info-'));
    const file = join(dir, 'three.pdf');
    await Bun.write(file, blankPdf(3, 595, 842));
    expect(await getPdfInfo(file)).toEqual({ pages: 3, pageSize: { width: 595, height: 842 } });
  });

  it.skipIf(!HAS_POPPLER)(
    'throws for a file that is not a PDF, rather than answering 0',
    async () => {
      dir = await mkdtemp(join(tmpdir(), 'yaar-pdf-info-'));
      const file = join(dir, 'not.pdf');
      await Bun.write(file, 'plain text');
      const failure = await getPdfInfo(file).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(PopplerNotInstalledError);
    },
  );
});
