import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'path';
import { brotliDecompressSync } from 'node:zlib';
import { PROJECT_ROOT } from '../config/env.js';
import { permissionsAllow } from '../http/access.js';
import { initRegistry } from '../handlers/index.js';
import { parseOpenType, inspectCff, subsetGlyf } from '@yaar/lib/fonts';
import {
  listFaces,
  listFamilies,
  matchWeight,
  resetFontCatalogForTest,
  subsetForText,
  urlFaceCss,
  MAX_SUBSET_CHARS,
} from '../features/fonts/index.js';

/**
 * The catalog is pointed at `packages/frontend/public/`, not the built
 * `dist/`. Both hold the same font files, but only `public/` is in git — a suite
 * that read `dist/` would pass on a developer's machine and find an empty
 * catalog on a CI checkout that had not built the frontend yet.
 */
const previousDist = process.env.FRONTEND_DIST;

beforeAll(() => {
  process.env.FRONTEND_DIST = join(PROJECT_ROOT, 'packages', 'frontend', 'public');
  resetFontCatalogForTest();
});

afterAll(() => {
  if (previousDist === undefined) delete process.env.FRONTEND_DIST;
  else process.env.FRONTEND_DIST = previousDist;
  resetFontCatalogForTest();
});

describe('the served font catalog', () => {
  it('lists the four NanumSquareNeo weights the repo ships', () => {
    const nanum = listFamilies().find((f) => f.family === 'NanumSquareNeo');
    expect(nanum).toBeDefined();
    expect(nanum!.mono).toBe(false);
    expect(nanum!.weights.sort((a, b) => a - b)).toEqual([300, 400, 700, 800]);
  });

  it('serves a monospace family, so code has a face to be set in', () => {
    const mono = listFamilies().find((f) => f.mono);
    expect(mono).toBeDefined();
    expect(mono!.family).toBe('D2Coding');
  });

  /**
   * The declared list carries faces this build may not have — D2Coding Bold is
   * declared and deliberately not shipped. Advertising one would fail at subset
   * time instead of degrading, which is the whole reason `getFrontendAsset`
   * proves a file exists rather than composing a path.
   */
  it('omits a declared face whose file is not in the build', () => {
    expect(listFaces().some((f) => f.url === '/D2CodingBold.ttf')).toBe(false);
    // ...and the weight it would have answered for resolves down rather than
    // out of the family, so bold code renders regular instead of as a fallback.
    expect(matchWeight('D2Coding', 700)?.weight).toBe(400);
  });

  it('names each face with the format hint its container actually needs', () => {
    const css = urlFaceCss('NanumSquareNeo');
    expect(css).toContain("src:url(/NanumSquareNeoOTF-Rg.otf) format('opentype')");
    expect(css).toContain('font-weight:400');
  });

  /**
   * CSS Fonts 4 §5.2, and it has to be exact: a caller embeds whichever face
   * this returns and lays text out with whichever face the browser picked, so
   * disagreeing here means one weight drawn and another measured.
   */
  it('resolves a weight the way CSS font matching would', () => {
    expect(matchWeight('NanumSquareNeo', 400)?.weight).toBe(400);
    // At or below 500, prefer the nearest weight at or below the target...
    expect(matchWeight('NanumSquareNeo', 500)?.weight).toBe(400);
    expect(matchWeight('NanumSquareNeo', 350)?.weight).toBe(300);
    // ...above 500, the nearest at or above.
    expect(matchWeight('NanumSquareNeo', 600)?.weight).toBe(700);
    expect(matchWeight('NanumSquareNeo', 900)?.weight).toBe(800);
    expect(matchWeight('Nonexistent', 400)).toBeNull();
  });
});

/**
 * The gate, not the handler. slides-lite declares `"permissions": []` and still
 * has to reach the subsetter, so if this row were missing the whole port would
 * 403 at the door with every other test in this file still green.
 *
 * It is a commons rather than a declared grant because the font files are
 * already served unauthenticated — an app can `fetch()` the whole 1.6 MB face
 * today, so a permission here would guard nothing while making the user approve
 * a prompt for typography.
 */
describe('reaching the font catalog', () => {
  it('is granted to any app, with nothing declared', () => {
    for (const verb of ['read', 'list', 'invoke'] as const) {
      expect(permissionsAllow([], 'slides-lite', 'yaar://system/fonts', verb)).toBe(true);
    }
  });

  it('does not widen the rest of yaar://system', () => {
    expect(permissionsAllow([], 'slides-lite', 'yaar://system/update', 'invoke')).toBe(false);
    expect(permissionsAllow([], 'slides-lite', 'yaar://system', 'list')).toBe(false);
    // A prefix that merely starts with the same characters is a different resource.
    expect(permissionsAllow([], 'slides-lite', 'yaar://system/fontsecrets', 'read')).toBe(false);
  });

  /** `appId` is the whole condition — a non-app iframe has no identity to grant to. */
  it('grants nothing to a caller with no app identity', () => {
    expect(permissionsAllow([], undefined, 'yaar://system/fonts', 'read')).toBe(false);
  });
});

describe('subsetting a served face', () => {
  const text = 'Hello 안녕하세요 0123';

  it('returns a font that still maps every character to the same glyph id', async () => {
    const result = await subsetForText({ text, weights: [400] });
    const face = result.faces[0];

    expect(face.outlines).toBe('cff');
    expect(face.dataUrl.startsWith('data:font/otf;base64,')).toBe(true);
    expect(result.missing).toEqual([]);

    // The point of preserving indices: the subset is loadable as a webfont *and*
    // addressable by a PDF using the ids reported here. A renumbering subsetter
    // would pass every other assertion and fail this one.
    const bytes = Buffer.from(face.dataUrl.slice('data:font/otf;base64,'.length), 'base64');
    const round = parseOpenType(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    for (const [ch, gid] of Object.entries(face.gids)) {
      expect(round.gidFor(ch.codePointAt(0)!)).toBe(gid);
    }
    expect(Object.keys(face.gids).length).toBeGreaterThan(10);
  });

  it('carries an outline per requested glyph, plus .notdef', async () => {
    const result = await subsetForText({ text, weights: [400], outlineTable: true });
    const face = result.faces[0];
    expect(face.outlineTableBase64).toBeDefined();

    const cff = new Uint8Array(Buffer.from(face.outlineTableBase64!, 'base64'));
    const info = inspectCff(cff);
    expect(info.isCID).toBe(true);
    // Every glyph index survives — that is what keeps cmap/hmtx/GPOS valid.
    expect(info.glyphCount).toBeGreaterThan(10000);
    // ...but only the wanted ones keep an outline. `.notdef` is glyph 0 and is
    // always kept, so it is the one extra.
    const withOutlines = info.charStrings.filter((cs) => cs.length > 1).length;
    expect(withOutlines).toBe(face.glyphs + 1);
  });

  it('is a small fraction of the 1.6MB face it came from', async () => {
    const result = await subsetForText({ text, weights: [400] });
    expect(result.faces[0].bytes).toBeLessThan(300 * 1024);
  });

  it('omits the outline table unless asked, since it doubles the response', async () => {
    const result = await subsetForText({ text, weights: [400] });
    expect(result.faces[0].outlineTableBase64).toBeUndefined();
  });

  it('reports an uncovered character instead of failing the request', async () => {
    const result = await subsetForText({ text: 'A🙂', weights: [400] });
    expect(result.missing).toEqual(['🙂']);
    expect(result.faces[0].gids['A']).toBeGreaterThan(0);
  });

  /**
   * The subsetters keep every glyph index and empty the dropped outlines, so the
   * original cmap would map a dropped character to an empty glyph: a browser
   * would draw nothing for it instead of falling back to the next face.
   */
  it('maps only the characters it carries, so the rest fall back', async () => {
    const result = await subsetForText({ text: 'A가', weights: [400] });
    const bytes = Buffer.from(result.faces[0].dataUrl.split(',')[1], 'base64');
    const round = parseOpenType(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    expect(round.gidFor('A'.codePointAt(0)!)).toBe(result.faces[0].gids['A']);
    expect(round.gidFor('가'.codePointAt(0)!)).toBe(result.faces[0].gids['가']);
    expect(round.gidFor('B'.codePointAt(0)!)).toBe(0);
    expect(round.gidFor('각'.codePointAt(0)!)).toBe(0);
  });

  /**
   * Two requested weights can land on one file. Subsetting it twice would embed
   * the same bytes twice — in a data: URL, that is the whole subset paid again.
   */
  it('embeds one copy when two weights resolve to the same file', async () => {
    const result = await subsetForText({ text, weights: [400, 500] });
    expect(result.faces).toHaveLength(2);
    expect(result.faces[0].dataUrl).toBe(result.faces[1].dataUrl);
    // ...but the CSS still names each requested weight, or the browser would
    // pick a fallback for the one that went unnamed.
    expect(result.css).toContain('font-weight:400');
    expect(result.css).toContain('font-weight:500');
    expect(result.faces[1].servedWeight).toBe(400);
  });

  it('refuses a corpus rather than silently shortening the character set', async () => {
    const huge = Array.from({ length: MAX_SUBSET_CHARS + 1 }, (_, i) =>
      String.fromCodePoint(0x4e00 + i),
    ).join('');
    await expect(subsetForText({ text: huge })).rejects.toThrow(/Too many distinct characters/);
  });

  it('refuses an empty request and an unknown family by name', async () => {
    await expect(subsetForText({ text: '' })).rejects.toThrow(/Provide `text`/);
    await expect(subsetForText({ text: 'A', family: 'Nope' })).rejects.toThrow(
      /Unknown font family "Nope"/,
    );
  });
});

/**
 * Through the registry, the way `POST /api/verb` and the MCP verb tools both
 * reach it — so a handler that never registered, or a URI `resolveUri` cannot
 * parse, fails here rather than in an app.
 *
 * `structuredContent` is the field the app SDK actually reads (`toEnvelope`
 * unwraps it), so a shape mismatch between the handler and `@bundled/yaar`'s
 * types would surface as an app getting `undefined` at runtime with every
 * unit test in this file still green.
 */
/** Read a WOFF2 back to its tables: header, null-transform directory, one brotli stream. */
function decodeWoff2(bytes: Uint8Array): { flavor: number; tables: Map<string, Uint8Array> } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0)).toBe(0x774f4632);
  expect(view.getUint32(8)).toBe(bytes.length);
  const count = view.getUint16(12);
  // The spec's known-tag table, restated here so the test checks the encoder against it.
  const KNOWN = (
    'cmap|head|hhea|hmtx|maxp|name|OS/2|post|cvt |fpgm|glyf|loca|prep|CFF |VORG|EBDT|' +
    'EBLC|gasp|hdmx|kern|LTSH|PCLT|VDMX|vhea|vmtx|BASE|GDEF|GPOS|GSUB|EBSC|JSTF|MATH|' +
    'CBDT|CBLC|COLR|CPAL|SVG |sbix|acnt|avar|bdat|bloc|bsln|cvar|fdsc|feat|fmtx|fvar|' +
    'gvar|hsty|just|lcar|mort|morx|opbd|prop|trak|Zapf|Silf|Glat|Gloc|Feat|Sill'
  ).split('|');
  let at = 48;
  const dir: [string, number][] = [];
  for (let i = 0; i < count; i++) {
    const flags = bytes[at++];
    let tag = KNOWN[flags & 63] ?? '';
    if ((flags & 63) === 63) {
      tag = String.fromCharCode(...bytes.subarray(at, at + 4));
      at += 4;
    }
    let length = 0;
    for (let b = bytes[at++]; ; b = bytes[at++]) {
      length = length * 128 + (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    dir.push([tag, length]);
  }
  const stream = brotliDecompressSync(bytes.subarray(at, at + view.getUint32(20)));
  const tables = new Map<string, Uint8Array>();
  let offset = 0;
  for (const [tag, length] of dir) {
    tables.set(tag, new Uint8Array(stream.subarray(offset, offset + length)));
    offset += length;
  }
  expect(offset).toBe(stream.length);
  return { flavor: view.getUint32(4), tables };
}

describe('subsetting to WOFF2', () => {
  const text = 'Hello 안녕하세요 0123';

  it('carries the same tables as the OpenType subset, in about a third of the bytes', async () => {
    const otf = (await subsetForText({ text, weights: [400] })).faces[0];
    const result = await subsetForText({ text, weights: [400], woff2: true });
    const face = result.faces[0];
    expect(face.dataUrl.startsWith('data:font/woff2;base64,')).toBe(true);
    expect(result.css).toContain("format('woff2')");
    expect(face.bytes).toBeLessThan(otf.bytes / 2);

    const sfnt = Buffer.from(otf.dataUrl.split(',')[1], 'base64');
    const font = parseOpenType(
      sfnt.buffer.slice(sfnt.byteOffset, sfnt.byteOffset + sfnt.byteLength),
    );
    const { flavor, tables } = decodeWoff2(
      new Uint8Array(Buffer.from(face.dataUrl.split(',')[1], 'base64')),
    );
    expect(flavor).toBe(0x4f54544f); // 'OTTO'
    expect([...tables.keys()].sort()).toEqual([...font.tables.keys()].sort());
    for (const [tag, rec] of font.tables) {
      expect(tables.get(tag)).toEqual(font.bytes.subarray(rec.offset, rec.offset + rec.length));
    }
  });

  it('wraps a TrueType face with glyf and loca null-transformed', async () => {
    const result = await subsetForText({ text: 'A가', family: 'D2Coding', woff2: true });
    const bytes = new Uint8Array(Buffer.from(result.faces[0].dataUrl.split(',')[1], 'base64'));
    const { flavor, tables } = decodeWoff2(bytes);
    expect(flavor).toBe(0x00010000);
    expect(tables.has('glyf')).toBe(true);
    expect(tables.has('loca')).toBe(true);
  });
});

describe('the yaar://system/fonts door', () => {
  it('resolves and answers read with the catalog the SDK expects', async () => {
    const result = await initRegistry().execute('read', 'yaar://system/fonts');
    expect(result.isError).toBeUndefined();
    const data = result.structuredContent as { families: unknown[]; faces: unknown[]; css: string };
    expect(Array.isArray(data.families)).toBe(true);
    expect(data.css).toContain('@font-face');
  });

  it('answers invoke with css, faces and missing', async () => {
    const result = await initRegistry().execute('invoke', 'yaar://system/fonts', {
      text: 'Hi 한글',
      weights: [400],
    });
    expect(result.isError).toBeUndefined();
    const data = result.structuredContent as {
      css: string;
      faces: Array<{ dataUrl: string; gids: Record<string, number> }>;
      missing: string[];
    };
    expect(data.css).toContain('src:url(data:font/otf;base64,');
    expect(data.faces[0].gids['한']).toBeGreaterThan(0);
    expect(data.missing).toEqual([]);
  });

  it('is listed from the system namespace root, so it is discoverable', async () => {
    const result = await initRegistry().execute('list', 'yaar://system');
    const text = result.content.map((b) => JSON.stringify(b)).join('');
    expect(text).toContain('yaar://system/fonts');
  });

  it('turns a refused request into an error result, not a throw', async () => {
    const result = await initRegistry().execute('invoke', 'yaar://system/fonts', { text: '' });
    expect(result.isError).toBe(true);
  });
});

describe('subsetting the monospace face', () => {
  /**
   * D2Coding is TrueType, NanumSquareNeo is CFF — which is why `@yaar/lib/fonts`
   * carries a subsetter for each. This is the only coverage the `glyf` path gets
   * against a real 26,000-glyph font rather than the fixture below.
   */
  it('round-trips a TrueType face with its glyph ids intact', async () => {
    const result = await subsetForText({
      text: 'const x = 1; // 한글 주석',
      family: 'D2Coding',
      weights: [400],
    });
    const face = result.faces[0];
    expect(face.outlines).toBe('glyf');
    expect(face.dataUrl.startsWith('data:font/ttf;base64,')).toBe(true);
    expect(result.missing).toEqual([]);

    const bytes = Buffer.from(face.dataUrl.slice('data:font/ttf;base64,'.length), 'base64');
    const round = parseOpenType(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    expect(round.outlines).toBe('glyf');
    for (const [ch, gid] of Object.entries(face.gids)) {
      expect(round.gidFor(ch.codePointAt(0)!)).toBe(gid);
    }
  });

  it('announces a TrueType face as truetype, which a strict browser checks', async () => {
    const result = await subsetForText({ text: 'abc', family: 'D2Coding' });
    expect(result.css).toContain("format('truetype')");
    expect(result.css).not.toContain("format('opentype')");
  });

  /** A code face whose advances differ is not a code face. */
  it('reports one advance for every Latin glyph', async () => {
    const result = await subsetForText({ text: 'iMW l1', family: 'D2Coding' });
    const latin = Object.entries(result.faces[0].advances).filter(([ch]) => ch !== ' ');
    expect(new Set(latin.map(([, w]) => w)).size).toBe(1);
  });
});

/**
 * The fixture covers what a real font cannot be relied on to contain — a
 * composite glyph pointing at a glyph nobody asked for. Both behaviours are
 * invisible until something renders as nothing.
 */
describe('the TrueType outline subsetter', () => {
  /** Four glyphs; glyph 2 is a composite referencing glyph 3. */
  function fixture() {
    const simple = (): Uint8Array => {
      const g = new Uint8Array(12);
      new DataView(g.buffer).setInt16(0, 1); // one contour
      return g;
    };
    // A composite is a negative contour count and then a component list, which
    // starts at byte 10: flags, then the glyph id it references.
    const composite = new Uint8Array(16);
    const cv = new DataView(composite.buffer);
    cv.setInt16(0, -1);
    cv.setUint16(10, 0x0000); // byte-sized args, no MORE_COMPONENTS
    cv.setUint16(12, 3);

    const glyphs = [simple(), simple(), composite, simple()];

    const loca = new Uint32Array(5);
    let at = 0;
    const parts: number[] = [];
    glyphs.forEach((g, i) => {
      loca[i] = at;
      parts.push(...g);
      at += g.length;
    });
    loca[4] = at;

    // A `head` long enough to hold indexToLocFormat at offset 50.
    return { glyf: new Uint8Array(parts), loca, head: new Uint8Array(54) };
  }

  it('pulls in the components a kept composite references', () => {
    const { glyf, loca, head } = fixture();
    // Ask for the composite only. Glyph 3 must come along, or it draws nothing.
    const subset = subsetGlyf(glyf, loca, head, [2]);
    expect(subset.gids).toEqual([0, 2, 3]);
  });

  it('gives a dropped glyph a zero-length span rather than a new index', () => {
    const { glyf, loca, head } = fixture();
    const subset = subsetGlyf(glyf, loca, head, [1]);
    const out = new DataView(subset.loca.buffer, subset.loca.byteOffset, subset.loca.byteLength);
    // Still five offsets: every index survives, which is what keeps cmap valid.
    expect(subset.loca.byteLength).toBe(5 * 4);
    // Glyph 2 was dropped, so its span is empty; glyph 1 was kept, so its is not.
    expect(out.getUint32(2 * 4)).toBe(out.getUint32(3 * 4));
    expect(out.getUint32(1 * 4)).toBeLessThan(out.getUint32(2 * 4));
  });

  it('forces head.indexToLocFormat to long, to match the loca it wrote', () => {
    const { glyf, loca, head } = fixture();
    const subset = subsetGlyf(glyf, loca, head, [1]);
    expect(new DataView(subset.head.buffer).getInt16(50)).toBe(1);
  });
});
