/**
 * Settings slice - manages user preferences (persisted to localStorage).
 */
import type { SliceCreator, SettingsSlice } from '../types';

const STORAGE_KEY = 'yaar-settings';

function loadSettings(): { userName: string; language: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        userName: parsed.userName ?? '',
        language: parsed.language ?? 'en',
      };
    }
  } catch {
    /* ignore */
  }
  return { userName: '', language: 'en' };
}

function saveSettings(settings: { userName: string; language: string }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

const initial = loadSettings();

export const createSettingsSlice: SliceCreator<SettingsSlice> = (set, get) => ({
  userName: initial.userName,
  language: initial.language,

  setUserName: (name) =>
    set((state) => {
      state.userName = name;
      saveSettings({ userName: name, language: get().language });
    }),

  setLanguage: (lang) =>
    set((state) => {
      state.language = lang;
      saveSettings({ userName: get().userName, language: lang });
    }),
});
