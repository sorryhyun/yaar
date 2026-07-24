export {};

// Pure image/byte helpers. No storage, no signals — unit-testable.

/** ArrayBuffer → base64, chunked so a large image does not blow the argument limit. */
export function base64FromBuffer(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
