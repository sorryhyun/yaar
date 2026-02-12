/**
 * Image utilities for converting data URLs to WebP format.
 * Shared across providers to reduce payload size.
 */

import sharp from 'sharp';

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

/**
 * Convert an image data URL to WebP format for better compression.
 * Reduces payload size when sending base64 images to AI providers.
 */
export async function convertToWebP(dataUrl: string): Promise<string> {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return dataUrl;

  // Skip if already WebP or GIF (might be animated)
  if (parsed.mediaType === 'image/webp' || parsed.mediaType === 'image/gif') {
    return dataUrl;
  }

  try {
    const inputBuffer = Buffer.from(parsed.data, 'base64');
    const webpBuffer = await sharp(inputBuffer).webp({ quality: 90 }).toBuffer();
    const originalSize = inputBuffer.length;
    const newSize = webpBuffer.length;
    const savings = ((originalSize - newSize) / originalSize * 100).toFixed(1);
    console.log(`[image] Converted ${parsed.mediaType} to WebP: ${originalSize} → ${newSize} bytes (${savings}% smaller)`);
    return `data:image/webp;base64,${webpBuffer.toString('base64')}`;
  } catch (err) {
    console.warn(`[image] WebP conversion failed, using original:`, err);
    return dataUrl;
  }
}
