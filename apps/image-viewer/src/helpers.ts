/** Image file extension matcher */
export const IMAGE_EXT_REGEX = /\.(png|jpe?g|gif|webp|bmp)$/i;

export const STORAGE_UNAVAILABLE = 'Storage API unavailable.';

/** Extract file name from a path string */
export function baseName(path: string): string {
  return path.split('/').pop() || path;
}

/** Build the standard status bar text */
export function makeStatusText(count: number, currentMode: string, cols: number): string {
  return `${count} image(s) loaded · mode=${currentMode}${
    currentMode === 'grid' ? ` · cols=${cols}` : ''
  }`;
}

/** Clamp a columns value to the valid range [1, 8] */
export function clampColumns(n: number): number {
  return Math.max(1, Math.min(8, Math.floor(n) || 3));
}

/** Read a File as a base64 data URL */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
