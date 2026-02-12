/**
 * Image utilities for parsing data URLs.
 * Images are captured as WebP on the frontend, so no server-side conversion is needed.
 */

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/**
 * Parse a data URL to extract media type and base64 data.
 */
export function parseDataUrl(dataUrl: string): { mediaType: ImageMediaType; data: string } | null {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
  if (!match) return null;
  return {
    mediaType: match[1] as ImageMediaType,
    data: match[2],
  };
}
