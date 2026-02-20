/**
 * i18n setup — initializes i18next with all supported locales.
 * Import this before React renders (in main.tsx).
 *
 * Language is seeded from localStorage so the UI renders in the correct
 * language on first paint without a flicker.  Subsequent changes go through
 * i18next.changeLanguage(), which is called from settingsSlice.
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import ko from './locales/ko.json';
import ja from './locales/ja.json';
import zh from './locales/zh.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import pt from './locales/pt.json';

function getInitialLanguage(): string {
  try {
    const raw = localStorage.getItem('yaar-settings');
    if (raw) {
      const parsed = JSON.parse(raw) as { language?: string };
      if (typeof parsed.language === 'string') return parsed.language;
    }
  } catch {
    /* ignore */
  }
  return 'en';
}

i18next.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ko: { translation: ko },
    ja: { translation: ja },
    zh: { translation: zh },
    es: { translation: es },
    fr: { translation: fr },
    de: { translation: de },
    pt: { translation: pt },
  },
  lng: getInitialLanguage(),
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false, // React already escapes
  },
});

export default i18next;
