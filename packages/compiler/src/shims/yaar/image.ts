// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Re-encoding images inside an app iframe.
 *
 * No `@bundled/*` package ships a WebP codec and none needs to: apps run in Chromium,
 * which encodes and decodes WebP natively. What every app that wanted it had to write
 * by hand was the ~20 lines around that — decode to a bitmap, size a canvas, draw,
 * `convertToBlob`, check the encoder did not quietly fall back to PNG, get the bytes
 * back out as base64 for a storage write. devtools' `importAsset` wrote them; so would
 * the next app that publishes a render or uploads a photo. This is those lines, once.
 *
 * Deliberately NOT the same thing as the server-side re-encode in
 * `packages/server/src/lib/image.ts`: that one runs on bytes already on their way into
 * a model context and is not something an app can call. This one is for an app holding
 * pixels it is about to store, send, or show.
 */

/** Anything this module can encode from. A URL string is fetched first. */
export type ImageSource =
  | Blob
  | ImageBitmap
  | HTMLCanvasElement
  | OffscreenCanvas
  | HTMLImageElement
  | HTMLVideoElement
  | string;

export interface EncodeImageOptions {
  /**
   * Encoder quality, 0–1. Default 0.9. Ignored by lossless encoders (`image/png`),
   * and WebP treats 1 as lossless.
   */
  quality?: number;
  /**
   * Cap on the longest edge, in pixels. Downscale only — a smaller image is never
   * enlarged to meet it. Omit to keep the source's dimensions.
   */
  maxSize?: number;
  /** Output format. Default `image/webp`. */
  type?: 'image/webp' | 'image/png' | 'image/jpeg';
}

export interface EncodedImage {
  blob: Blob;
  /** Base64 *without* a data-URL prefix — what `appStorage.save(..., 'base64')` wants. */
  base64: string;
  /** The same bytes as a `data:` URL, for `<img src>` and content blocks. */
  dataUrl: string;
  bytes: number;
  width: number;
  height: number;
  mimeType: string;
}

/** Chunked so a multi-megabyte image does not blow the argument limit on `apply`. */
function base64FromBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(binary);
}

/** Natural pixel dimensions of any accepted drawable. */
function sizeOf(source: unknown): { width: number; height: number } {
  const s = source as Record<string, number>;
  return {
    width: s.naturalWidth || s.videoWidth || s.width || 0,
    height: s.naturalHeight || s.videoHeight || s.height || 0,
  };
}

/**
 * Re-encode an image, by default to WebP.
 *
 * Returns `null` rather than throwing when the browser cannot do it — an undecodable
 * or corrupt source, a canvas with no 2D context, or an encoder that declined the
 * format and silently handed back PNG. Every caller has a sensible fallback for that
 * (keep the original bytes), and a rejected promise would make the common case the
 * one that needs a try/catch.
 *
 * ```ts
 * const shot = await toWebP(canvas, { maxSize: 1024 });
 * if (shot) await appStorage.save('shots/latest.webp', shot.base64, { encoding: 'base64' });
 * ```
 *
 * A cross-origin image drawn without CORS taints the canvas and makes the encode
 * throw — you get `null`. Fetch it through `httpFetch` and pass the Blob instead.
 */
export async function toWebP(
  source: ImageSource,
  opts: EncodeImageOptions = {},
): Promise<EncodedImage | null> {
  const type = opts.type ?? 'image/webp';
  const quality = opts.quality ?? 0.9;

  try {
    let drawable: CanvasImageSource;
    let bitmap: ImageBitmap | null = null;

    if (typeof source === 'string') {
      const res = await fetch(source);
      bitmap = await createImageBitmap(await res.blob());
      drawable = bitmap;
    } else if (source instanceof Blob) {
      bitmap = await createImageBitmap(source);
      drawable = bitmap;
    } else {
      drawable = source as CanvasImageSource;
    }

    const natural = sizeOf(drawable);
    if (!natural.width || !natural.height) {
      bitmap?.close();
      return null;
    }

    const cap = opts.maxSize;
    const scale = cap ? Math.min(1, cap / Math.max(natural.width, natural.height)) : 1;
    const width = Math.max(1, Math.round(natural.width * scale));
    const height = Math.max(1, Math.round(natural.height * scale));

    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap?.close();
      return null;
    }
    ctx.drawImage(drawable, 0, 0, width, height);
    bitmap?.close();

    const blob: Blob | null =
      typeof (canvas as OffscreenCanvas).convertToBlob === 'function'
        ? await (canvas as OffscreenCanvas).convertToBlob({ type, quality })
        : await new Promise((resolve) =>
            (canvas as HTMLCanvasElement).toBlob(resolve, type, quality),
          );

    // `toBlob`/`convertToBlob` fall back to PNG for a format they do not support rather
    // than failing, so the returned type is the only thing that says whether the encode
    // actually happened. Silently shipping a PNG named .webp is worse than saying no.
    if (!blob || blob.type !== type) return null;

    const buffer = await blob.arrayBuffer();
    const base64 = base64FromBuffer(buffer);
    return {
      blob,
      base64,
      dataUrl: `data:${type};base64,${base64}`,
      bytes: buffer.byteLength,
      width,
      height,
      mimeType: type,
    };
  } catch {
    return null;
  }
}
