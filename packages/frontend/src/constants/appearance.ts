/** Preset data for wallpapers, accent colors, and icon sizes. */
import { ACCENT_PRESETS_DATA } from '@yaar/shared';

export interface WallpaperPreset {
  key: string;
  label: string;
  css: string;
}

/** Gradient artwork, tuned to sit behind the GitHub-dark shell (base #0f1117). */
export const WALLPAPER_PRESETS: WallpaperPreset[] = [
  {
    key: 'dark-blue',
    label: 'Dark Blue',
    css: 'linear-gradient(135deg, #0d1117 0%, #101a2e 50%, #0f2a52 100%)',
  },
  {
    key: 'midnight',
    label: 'Midnight',
    css: 'linear-gradient(135deg, #10101c 0%, #1d1533 50%, #150e33 100%)',
  },
  {
    key: 'aurora',
    label: 'Aurora',
    css: 'linear-gradient(135deg, #0d1512 0%, #0f2420 50%, #0c2b2b 100%)',
  },
  {
    key: 'ember',
    label: 'Ember',
    css: 'linear-gradient(135deg, #1a100c 0%, #2a160e 50%, #331a0a 100%)',
  },
  {
    key: 'ocean',
    label: 'Ocean',
    css: 'linear-gradient(135deg, #0a1220 0%, #0c1e33 50%, #0a2947 100%)',
  },
  {
    key: 'moss',
    label: 'Moss',
    css: 'linear-gradient(135deg, #0f150c 0%, #14200f 50%, #1a260e 100%)',
  },
];

export function resolveWallpaper(value: string): string {
  const preset = WALLPAPER_PRESETS.find((p) => p.key === value);
  return preset ? preset.css : value;
}

export interface AccentPreset {
  key: string;
  color: string;
  hover: string;
  /** Darker fill for white-text buttons — see the `*Emphasis` note in tokens.ts. */
  emphasis: string;
  emphasisHover: string;
}

/** Sourced from the canonical token data so picker colors and hovers cannot drift. */
export const ACCENT_PRESETS: AccentPreset[] = ACCENT_PRESETS_DATA.map((p) => ({ ...p }));

export function resolveAccent(key: string): AccentPreset | undefined {
  return ACCENT_PRESETS.find((p) => p.key === key);
}

export type IconSizeKey = 'small' | 'medium' | 'large';

export interface IconSizePreset {
  key: IconSizeKey;
  label: string;
  iconPx: number;
  labelMaxWidth: number;
  gridGap: number;
}

export const ICON_SIZE_PRESETS: IconSizePreset[] = [
  { key: 'small', label: 'Small', iconPx: 36, labelMaxWidth: 64, gridGap: 12 },
  { key: 'medium', label: 'Medium', iconPx: 48, labelMaxWidth: 80, gridGap: 16 },
  { key: 'large', label: 'Large', iconPx: 64, labelMaxWidth: 96, gridGap: 20 },
];

export function resolveIconSize(key: IconSizeKey): IconSizePreset {
  return ICON_SIZE_PRESETS.find((p) => p.key === key) ?? ICON_SIZE_PRESETS[1];
}
