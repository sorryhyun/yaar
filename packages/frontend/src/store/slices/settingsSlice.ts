/**
 * Settings slice - manages user preferences (persisted to localStorage).
 * Language syncs to server via PATCH /api/settings so the AI knows the user's language.
 */
import type { SliceCreator, SettingsSlice } from '../types';
import { apiFetch } from '@/lib/api';
import type { IconSizeKey } from '@/constants/appearance';
import i18next from 'i18next';

const STORAGE_KEY = 'yaar-settings';

interface PersistedSettings {
  userName: string;
  language: string;
  wallpaper: string;
  accentColor: string;
  iconSize: IconSizeKey;
}

function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        userName: parsed.userName ?? '',
        language: parsed.language ?? 'en',
        wallpaper: parsed.wallpaper ?? 'dark-blue',
        accentColor: parsed.accentColor ?? 'blue',
        iconSize: parsed.iconSize ?? 'medium',
      };
    }
  } catch {
    /* ignore */
  }
  return {
    userName: '',
    language: 'en',
    wallpaper: 'dark-blue',
    accentColor: 'blue',
    iconSize: 'medium',
  };
}

function saveSettings(settings: PersistedSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

function getAllSettings(
  get: () => {
    userName: string;
    language: string;
    wallpaper: string;
    accentColor: string;
    iconSize: IconSizeKey;
  },
): PersistedSettings {
  const s = get();
  return {
    userName: s.userName,
    language: s.language,
    wallpaper: s.wallpaper,
    accentColor: s.accentColor,
    iconSize: s.iconSize,
  };
}

const initial = loadSettings();

export const createSettingsSlice: SliceCreator<SettingsSlice> = (set, get) => ({
  userName: initial.userName,
  language: initial.language,
  wallpaper: initial.wallpaper,
  accentColor: initial.accentColor,
  iconSize: initial.iconSize,

  setUserName: (name) =>
    set((state) => {
      state.userName = name;
      saveSettings({ ...getAllSettings(get), userName: name });
    }),

  setLanguage: (lang) => {
    set((state) => {
      state.language = lang;
      saveSettings({ ...getAllSettings(get), language: lang });
    });
    i18next.changeLanguage(lang);
    apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: lang }),
    }).catch(() => {});
  },

  applyServerLanguage: (lang) => {
    set((state) => {
      state.language = lang;
      saveSettings({ ...getAllSettings(get), language: lang });
    });
    i18next.changeLanguage(lang);
  },

  setWallpaper: (value) =>
    set((state) => {
      state.wallpaper = value;
      saveSettings({ ...getAllSettings(get), wallpaper: value });
    }),

  setAccentColor: (key) =>
    set((state) => {
      state.accentColor = key;
      saveSettings({ ...getAllSettings(get), accentColor: key });
    }),

  setIconSize: (size) =>
    set((state) => {
      state.iconSize = size;
      saveSettings({ ...getAllSettings(get), iconSize: size });
    }),
});
