/**
 * Unified settings helper — reads/writes config/settings.json.
 */

import { configRead, configWrite } from './storage-manager.js';

export interface Settings {
  onboardingCompleted: boolean;
  userName: string;
  language: string;
  provider: 'auto' | 'claude' | 'codex';
  wallpaper: string;
  accentColor: string;
  iconSize: 'small' | 'medium' | 'large';
  allowAllApps: boolean;
}

const DEFAULTS: Settings = {
  onboardingCompleted: false,
  userName: '',
  language: 'en',
  provider: 'auto',
  wallpaper: 'dark-blue',
  accentColor: 'blue',
  iconSize: 'medium',
  allowAllApps: true,
};

export const LANGUAGE_CODES = [
  'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'ar',
  'hi', 'it', 'nl', 'pl', 'tr', 'vi', 'th', 'id', 'sv', 'uk',
] as const;

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  ko: '한국어',
  ja: '日本語',
  zh: '中文',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  ru: 'Русский',
  ar: 'العربية',
  hi: 'हिन्दी',
  it: 'Italiano',
  nl: 'Nederlands',
  pl: 'Polski',
  tr: 'Türkçe',
  vi: 'Tiếng Việt',
  th: 'ไทย',
  id: 'Bahasa Indonesia',
  sv: 'Svenska',
  uk: 'Українська',
};

export function getLanguageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ?? code;
}

export async function readSettings(): Promise<Settings> {
  const result = await configRead('settings.json');
  if (result.success && result.content) {
    try {
      const parsed = JSON.parse(result.content);
      return { ...DEFAULTS, ...parsed };
    } catch {
      // ignore
    }
  }
  return DEFAULTS;
}

/**
 * Merge partial updates into settings and persist.
 */
export async function updateSettings(partial: Partial<Settings>): Promise<Settings> {
  const current = await readSettings();
  const updated = { ...current, ...partial };
  await configWrite('settings.json', JSON.stringify(updated));
  return updated;
}
