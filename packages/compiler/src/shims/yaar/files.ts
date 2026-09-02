// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Getting bytes out of an app and back into one.
 *
 * Two browser dances with no decisions in them, hand-copied six and four times
 * respectively across the fleet — two apps independently extracted `downloadBlob`
 * with the same name and the same signature, which is as clear a signal as this
 * kind of audit produces. The FileReader wrapper fared worse: four copies under
 * three names (`blobToDataUrl`, `fileToDataUrl`, and twice inlined).
 *
 * Deliberately *not* about storage: `appStorage.save(path, …)` is how an app
 * keeps a file. This is the boundary with the user's own filesystem (a download
 * they asked for) and with APIs that want a `data:` URL rather than a Blob.
 *
 * The return trips (`dataUrlToBlob`, `base64ToBytes`) came a round later, from
 * the same kind of count: six apps decoding a data URL by hand, three decoding
 * base64 with the same `atob` loop, two of them twice because the API wraps
 * its base64 at a column. `bytesToBase64` is the forward trip without a
 * FileReader — it lives in `image.ts`, where `toWebP` and `appStorage` already
 * needed it, and is re-exported under that name from the barrel.
 */

/**
 * Trigger a browser download of `blob`, named `filename`.
 *
 * The revoke is deferred a tick rather than run right after `click()`: the click
 * only *schedules* the download, and revoking the object URL synchronously races
 * the fetch of the very URL that was just handed to the browser.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Appended rather than clicked detached: a detached <a> click is a no-op in
  // Firefox, and costs nothing in Chromium.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Read a Blob or File into a `data:` URL (base64, with the MIME prefix).
 *
 * For an image an app is about to store or show, prefer `toWebP` — it returns
 * the data URL *and* the raw base64 `appStorage.save(..., 'base64')` wants,
 * after re-encoding. This is the general case: any blob, no re-encode.
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Decode base64 into bytes. Whitespace is stripped first: APIs that wrap
 * base64 at a column (GitHub's contents endpoint, MIME) hand back newlines
 * `atob` rejects. Throws on input that is not base64 — a caller that would
 * rather have `null` wraps it.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The return trip of `blobToDataUrl`: a `data:` URL back into a Blob carrying
 * the declared MIME type (`application/octet-stream` when none is declared).
 * Handles both the `;base64,` and the percent-encoded form. Throws on a string
 * that is not a data URL.
 *
 * Only for bytes an app already holds as a data URL — a canvas `toDataURL`, a
 * stored image read back as one. Bytes that arrive as a Blob stay a Blob.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/i.exec(dataUrl.trim());
  if (!match) throw new Error('not a data: URL');
  const type = match[1] || 'application/octet-stream';
  const body = match[3];
  if (/;base64$/i.test(match[2])) return new Blob([base64ToBytes(body)], { type });
  return new Blob([decodeURIComponent(body)], { type });
}
