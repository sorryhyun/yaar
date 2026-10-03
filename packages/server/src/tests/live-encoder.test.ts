/**
 * Live-stream encoding (`features/live-encoder/encoder.ts`): which codec a viewer gets,
 * what it may ask for, and the envelope both sockets share.
 *
 * Encoding itself needs a real Chrome with WebCodecs, so it is verified by driving the
 * Browser app live (docs/proposals/browser_proposal.md has the numbers). What is here is
 * the part that must not drift silently: a codec order that puts a blurring encoder first,
 * a `?codecs=` that lets an unknown string through to the encoder page, or a page route
 * that answers without the tab's secret.
 */
import { describe, it, expect } from 'bun:test';
import {
  CODEC_FAMILIES,
  envelope,
  handleLiveEncoderRoutes,
  parseCodecFamilies,
  pickCodec,
} from '../features/live-encoder/encoder.js';

describe('parseCodecFamilies', () => {
  it('keeps known families once, in the order given', () => {
    expect(parseCodecFamilies('vp09,av01,vp09')).toEqual(['vp09', 'av01']);
  });

  it('drops anything it does not know, and reads absence as JPEG', () => {
    expect(parseCodecFamilies('av01,hvc1,<script>')).toEqual(['av01']);
    expect(parseCodecFamilies('')).toEqual([]);
    expect(parseCodecFamilies(null)).toEqual([]);
  });
});

describe('pickCodec', () => {
  it('prefers AV1, whatever order either side lists', () => {
    expect(CODEC_FAMILIES[0]).toBe('av01');
    expect(pickCodec(['vp09', 'av01'], ['vp09', 'avc1', 'av01'])).toBe('av01');
  });

  it('takes the first family both sides have', () => {
    expect(pickCodec(['av01', 'vp09'], ['avc1', 'vp09'])).toBe('vp09');
  });

  it('stays on JPEG when nothing is shared', () => {
    expect(pickCodec(['av01'], ['avc1'])).toBeNull();
    expect(pickCodec([], ['av01'])).toBeNull();
  });
});

describe('envelope', () => {
  it('is [u32 LE headerLen][header JSON][payload]', () => {
    const out = envelope({ op: 'frame', id: 'x', ts: 7 }, new Uint8Array([1, 2, 3]));
    const headerLen = out.readUInt32LE(0);
    expect(JSON.parse(out.subarray(4, 4 + headerLen).toString('utf8'))).toEqual({
      op: 'frame',
      id: 'x',
      ts: 7,
    });
    expect([...out.subarray(4 + headerLen)]).toEqual([1, 2, 3]);
  });
});

describe('handleLiveEncoderRoutes', () => {
  const server = { upgrade: () => true } as unknown as import('bun').Server<never>;

  it('leaves other paths to the next route', () => {
    const url = new URL('http://127.0.0.1/api/live-encoder/other');
    expect(handleLiveEncoderRoutes(new Request(url.href), url, server as never)).toBeNull();
  });

  it('refuses the page and the socket without the tab secret', () => {
    for (const path of ['/api/live-encoder/page', '/api/live-encoder/ws']) {
      const url = new URL(`http://127.0.0.1${path}?ch=guess`);
      const res = handleLiveEncoderRoutes(new Request(url.href), url, server as never);
      expect(res).toBeInstanceOf(Response);
      expect((res as Response).status).toBe(404);
    }
  });
});
