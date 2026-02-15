/**
 * Unified settings helper — reads/writes config/settings.json.
 * Migrates legacy onboarding.json on first read.
 */

import { configRead, configWrite } from './storage-manager.js';

export interface Settings {
  onboardingCompleted: boolean;
  language: string;
}

const DEFAULTS: Settings = {
  onboardingCompleted: false,
  language: 'en',
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

/**
 * Read settings, migrating from legacy onboarding.json if needed.
 */
export async function readSettings(): Promise<Settings> {
  const result = await configRead('settings.json');
  if (result.success && result.content) {
    try {
      const parsed = JSON.parse(result.content);
      return { ...DEFAULTS, ...parsed };
    } catch {
      // Fall through to migration
    }
  }

  // Try migrating from legacy onboarding.json
  const legacy = await configRead('onboarding.json');
  let onboardingCompleted = false;
  if (legacy.success && legacy.content) {
    try {
      const parsed = JSON.parse(legacy.content);
      onboardingCompleted = parsed.completed === true;
    } catch {
      // ignore
    }
  }

  const settings: Settings = { ...DEFAULTS, onboardingCompleted };
  await configWrite('settings.json', JSON.stringify(settings));
  return settings;
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
