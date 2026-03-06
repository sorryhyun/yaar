/**
 * Streaming body-size limiter — rejects oversized requests before buffering the entire body.
 */

export class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body too large (max ${maxBytes} bytes)`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Read a request body with a streaming size limit.
 *
 * 1. If Content-Length is present and exceeds maxBytes, rejects immediately.
 * 2. Otherwise streams chunks and aborts as soon as cumulative size exceeds maxBytes.
 */
export async function readBodyWithLimit(req: Request, maxBytes: number): Promise<Buffer> {
  const contentLength = req.headers.get('content-length');
  if (contentLength !== null) {
    const declared = parseInt(contentLength, 10);
    if (!Number.isNaN(declared) && declared > maxBytes) {
      throw new BodyTooLargeError(maxBytes);
    }
  }

  const reader = req.body?.getReader();
  if (!reader) {
    return Buffer.alloc(0);
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalSize += value.length;
    if (totalSize > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}
