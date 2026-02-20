export const RATIO_PRESETS = ['16:9', '4:3', '1:1'] as const;
export type RatioPreset = (typeof RATIO_PRESETS)[number] | 'custom';

export function parseAspectRatio(value: string): {
  width: number;
  height: number;
  cssValue: string;
  normalized: string;
  preset: RatioPreset;
} {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  const width = m ? Number(m[1]) : 16;
  const height = m ? Number(m[2]) : 9;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 16, height: 9, cssValue: '16 / 9', normalized: '16:9', preset: '16:9' };
  }

  const normWidth = Number(width.toFixed(3));
  const normHeight = Number(height.toFixed(3));
  const normalized = `${normWidth}:${normHeight}`;
  const preset = (RATIO_PRESETS.includes(normalized as (typeof RATIO_PRESETS)[number])
    ? normalized
    : 'custom') as RatioPreset;

  return {
    width: normWidth,
    height: normHeight,
    cssValue: `${normWidth} / ${normHeight}`,
    normalized,
    preset,
  };
}

export function normalizeAspectRatio(value: unknown): string {
  return parseAspectRatio(typeof value === 'string' ? value : '16:9').normalized;
}
