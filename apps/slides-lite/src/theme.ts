import type { ThemeId } from './types';

export interface ThemeMeta {
  name: string;
  bg: string;
  fg: string;
  accent: string;
  canvas: string;
}

export const THEMES: Record<ThemeId, ThemeMeta> = {
  'classic-light': {
    name: 'Classic Light',
    bg: '#ffffff',
    fg: '#1f2937',
    accent: '#2563eb',
    canvas: 'linear-gradient(180deg, #eef2ff 0%, #f8fafc 100%)',
  },
  'midnight-dark': {
    name: 'Midnight Dark',
    bg: '#111827',
    fg: '#f9fafb',
    accent: '#60a5fa',
    canvas: 'linear-gradient(180deg, #0f172a 0%, #111827 100%)',
  },
  ocean: {
    name: 'Ocean',
    bg: '#e0f2fe',
    fg: '#0c4a6e',
    accent: '#0284c7',
    canvas: 'linear-gradient(180deg, #dbeafe 0%, #e0f2fe 100%)',
  },
  sunset: {
    name: 'Sunset',
    bg: '#fff7ed',
    fg: '#7c2d12',
    accent: '#ea580c',
    canvas: 'linear-gradient(180deg, #ffedd5 0%, #fff7ed 100%)',
  },
};

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && value in THEMES;
}
