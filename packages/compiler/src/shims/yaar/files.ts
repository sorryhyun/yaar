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
