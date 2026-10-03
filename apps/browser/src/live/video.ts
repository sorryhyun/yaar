/**
 * The video half of the stream: decoding what the server's encoder tab produced.
 *
 * A viewer that can decode one of the server's codecs says so on connect (`?codecs=`),
 * and the server answers with encoded chunks instead of JPEGs when it encodes one of
 * them too (`packages/server/src/features/live-encoder/encoder.ts`). A chunk's header
 * says which codec it is and, on a key chunk, the coded size, so the decoder is
 * configured from the stream itself. A frame without `codec` is a JPEG, and paint.ts
 * keeps painting those.
 *
 * Every chunk depends on the ones before it, so nothing here may skip one once the
 * chain has started. What the decoder cannot use it says upward: a decode error asks
 * for a keyframe, and a second in a row gives up on video for this socket.
 */
import { getCanvas, getCtx, setRemoteSize, markFramePainted, send } from './context';
import { recordFrame } from './stats';

/**
 * The codecs the server may send, in its order. Keep in step with `CODECS` in
 * `packages/server/src/features/live-encoder/encoder-page.client.js`.
 */
const CODECS: readonly [family: string, codec: string][] = [
  ['av01', 'av01.0.12M.08'],
  ['avc1', 'avc1.640034'],
  ['vp09', 'vp09.00.51.08'],
];

let probe: Promise<string[]> | null = null;

/** The codec families this page can decode, for `?codecs=`. Asked once. */
export function decodableCodecs(): Promise<string[]> {
  probe ??= (async () => {
    if (typeof VideoDecoder === 'undefined') return [];
    const out: string[] = [];
    for (const [family, codec] of CODECS) {
      const support = await VideoDecoder.isConfigSupported({
        codec,
        codedWidth: 1280,
        codedHeight: 800,
        optimizeForLatency: true,
      }).catch(() => null);
      if (support?.supported) out.push(family);
    }
    return out;
  })();
  return probe;
}

/** The fields a video frame's header adds to the JPEG one. */
export interface VideoHeader {
  w: number;
  h: number;
  dropped: number;
  codec: string;
  key: boolean;
  ts: number;
  cw: number;
  ch: number;
}

let decoder: VideoDecoder | null = null;
/** `codec cw×ch` the decoder is configured for, so a key chunk at a new size reconfigures it. */
let configured = '';
/** Deltas are useless until a key chunk starts the chain. */
let awaitingKey = true;
/** A keyframe has been asked for and has not arrived yet. */
let keyRequested = false;
let errorsInRow = 0;
/** Each chunk's header, by timestamp, until its frame comes out of the decoder. */
const pending = new Map<number, { w: number; h: number; dropped: number; bytes: number }>();

function makeDecoder(): VideoDecoder {
  return new VideoDecoder({
    output: paintVideoFrame,
    error: () => {
      decoder = null;
      configured = '';
      awaitingKey = true;
      pending.clear();
      errorsInRow++;
      if (errorsInRow >= 2) {
        // The JPEG path is the permanent fallback: the server restarts on it and the
        // frames that follow carry no `codec`.
        send({ t: 'codec', codec: 'jpeg' });
      } else {
        askForKeyframe();
      }
    },
  });
}

function askForKeyframe(): void {
  if (keyRequested) return;
  keyRequested = true;
  send({ t: 'keyframe' });
}

export function decodeChunk(header: VideoHeader, data: Uint8Array, byteLength: number): void {
  if (header.key) {
    const config = `${header.codec} ${header.cw}x${header.ch}`;
    if (!decoder || decoder.state === 'closed') {
      decoder = makeDecoder();
      configured = '';
    }
    if (config !== configured) {
      decoder.configure({
        codec: header.codec,
        codedWidth: header.cw,
        codedHeight: header.ch,
        optimizeForLatency: true,
      });
      configured = config;
    }
    awaitingKey = false;
    keyRequested = false;
  } else if (awaitingKey || !decoder) {
    askForKeyframe();
    return;
  }

  pending.set(header.ts, { w: header.w, h: header.h, dropped: header.dropped, bytes: byteLength });
  decoder!.decode(
    new EncodedVideoChunk({
      type: header.key ? 'key' : 'delta',
      timestamp: header.ts,
      data,
    }),
  );
}

function paintVideoFrame(frame: VideoFrame): void {
  const info = pending.get(frame.timestamp);
  for (const ts of pending.keys()) {
    if (ts <= frame.timestamp) pending.delete(ts);
  }
  const canvas = getCanvas();
  const ctx = getCtx();
  if (!canvas || !ctx) {
    frame.close();
    return;
  }
  errorsInRow = 0;
  if (info) setRemoteSize(info.w, info.h);
  // As for a JPEG, the backing store is the frame's size: the encoder's even-rounded
  // device px, which input.ts maps through the remote viewport's CSS size anyway.
  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
  }
  ctx.drawImage(frame, 0, 0);
  frame.close();
  markFramePainted();
  recordFrame(info?.bytes ?? 0, info?.dropped);
}

/** Forget the stream: a new socket starts a new chain with a key chunk. */
export function resetVideo(): void {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null;
  configured = '';
  awaitingKey = true;
  keyRequested = false;
  errorsInRow = 0;
  pending.clear();
}
