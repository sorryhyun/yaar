/** Preset data for wallpapers, accent colors, and icon sizes. */

export interface WallpaperPreset {
  key: string;
  label: string;
  css: string;
}

export const WALLPAPER_PRESETS: WallpaperPreset[] = [
  {
    key: 'dark-blue',
    label: 'Dark Blue',
    css: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
  },
  {
    key: 'midnight',
    label: 'Midnight',
    css: 'linear-gradient(135deg, #1e1b2e 0%, #2d1b4e 50%, #1a1040 100%)',
  },
  {
    key: 'aurora',
    label: 'Aurora',
    css: 'linear-gradient(135deg, #1a2e1e 0%, #162e2a 50%, #0f3434 100%)',
  },
  {
    key: 'ember',
    label: 'Ember',
    css: 'linear-gradient(135deg, #2e1a1a 0%, #3e2116 50%, #402010 100%)',
  },
  {
    key: 'ocean',
    label: 'Ocean',
    css: 'linear-gradient(135deg, #0a1628 0%, #0d2137 50%, #0a2a4a 100%)',
  },
  {
    key: 'moss',
    label: 'Moss',
    css: 'linear-gradient(135deg, #1a2418 0%, #1e2e1a 50%, #243018 100%)',
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
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { key: 'blue', color: '#89b4fa', hover: '#a8c8fc' },
  { key: 'lavender', color: '#b4befe', hover: '#c8d0fe' },
  { key: 'mauve', color: '#cba6f7', hover: '#d9bef9' },
  { key: 'pink', color: '#f5c2e7', hover: '#f8d4ee' },
  { key: 'peach', color: '#fab387', hover: '#fcc5a3' },
  { key: 'yellow', color: '#f9e2af', hover: '#fbebc5' },
  { key: 'green', color: '#a6e3a1', hover: '#bdeab9' },
  { key: 'red', color: '#f38ba8', hover: '#f6a5bc' },
];

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
