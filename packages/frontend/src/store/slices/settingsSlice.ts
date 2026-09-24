/**
 * Settings slice - manages user preferences (persisted to localStorage).
 * Language syncs to server via PATCH /api/settings so the AI knows the user's language.
 */
import type { SliceCreator } from '../types';
import { apiFetch } from '@/lib/api';
import type { IconSizeKey } from '@/constants/appearance';
import i18next from 'i18next';
import { DEFAULT_WINDOW_SIZE_PRESET, type WindowSizePreset } from '@yaar/shared';

export interface SettingsSliceState {
  userName: string;
  language: string;
  wallpaper: string;
  accentColor: string;
  iconSize: 'small' | 'medium' | 'large';
  theme: 'dark' | 'light';
  /** Which hand holds the phone. The status badge sits in the top corner away from it. */
  handedness: 'right' | 'left';
  /** Size of a window that neither its opener nor its app.json sizes. */
  windowSize: WindowSizePreset;
}

export interface SettingsSliceActions {
  setUserName: (name: string) => void;
  setLanguage: (lang: string) => void;
  applyServerLanguage: (lang: string) => void;
  applyServerSettings: (settings: Partial<SettingsSliceState>) => void;
  setWallpaper: (value: string) => void;
  setAccentColor: (key: string) => void;
  setIconSize: (size: 'small' | 'medium' | 'large') => void;
  setTheme: (theme: 'dark' | 'light') => void;
  setHandedness: (handedness: 'right' | 'left') => void;
  setWindowSize: (size: WindowSizePreset) => void;
}

export type SettingsSlice = SettingsSliceState & SettingsSliceActions;

const STORAGE_KEY = 'yaar-settings';

interface PersistedSettings {
  userName: string;
  language: string;
  wallpaper: string;
  accentColor: string;
  iconSize: IconSizeKey;
  theme: 'dark' | 'light';
  handedness: 'right' | 'left';
  windowSize: WindowSizePreset;
}

const WINDOW_SIZES: readonly WindowSizePreset[] = ['small', 'medium', 'large'];

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
        theme: parsed.theme === 'light' ? 'light' : 'dark',
        handedness: parsed.handedness === 'left' ? 'left' : 'right',
        windowSize: WINDOW_SIZES.includes(parsed.windowSize)
          ? parsed.windowSize
          : DEFAULT_WINDOW_SIZE_PRESET,
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
    theme: 'dark',
    handedness: 'right',
    windowSize: DEFAULT_WINDOW_SIZE_PRESET,
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
    theme: 'dark' | 'light';
    handedness: 'right' | 'left';
    windowSize: WindowSizePreset;
  },
): PersistedSettings {
  const s = get();
  return {
    userName: s.userName,
    language: s.language,
    wallpaper: s.wallpaper,
    accentColor: s.accentColor,
    iconSize: s.iconSize,
    theme: s.theme,
    handedness: s.handedness,
    windowSize: s.windowSize,
  };
}

const initial = loadSettings();

export const createSettingsSlice: SliceCreator<SettingsSlice> = (set, get) => ({
  userName: initial.userName,
  language: initial.language,
  wallpaper: initial.wallpaper,
  accentColor: initial.accentColor,
  iconSize: initial.iconSize,
  theme: initial.theme,
  handedness: initial.handedness,
  windowSize: initial.windowSize,

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

  applyServerSettings: (settings) => {
    set((state) => {
      if (settings.userName !== undefined) state.userName = settings.userName;
      if (settings.language !== undefined) state.language = settings.language;
      if (settings.wallpaper !== undefined) state.wallpaper = settings.wallpaper;
      if (settings.accentColor !== undefined) state.accentColor = settings.accentColor;
      if (settings.iconSize !== undefined) state.iconSize = settings.iconSize;
      if (settings.theme !== undefined) state.theme = settings.theme;
      if (settings.handedness !== undefined) state.handedness = settings.handedness;
      if (settings.windowSize !== undefined) state.windowSize = settings.windowSize;
      saveSettings({ ...getAllSettings(get), ...settings } as PersistedSettings);
    });
    if (settings.language !== undefined) {
      i18next.changeLanguage(settings.language);
    }
  },

  setWallpaper: (value) => {
    set((state) => {
      state.wallpaper = value;
      saveSettings({ ...getAllSettings(get), wallpaper: value });
    });
    apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallpaper: value }),
    }).catch(() => {});
  },

  setAccentColor: (key) => {
    set((state) => {
      state.accentColor = key;
      saveSettings({ ...getAllSettings(get), accentColor: key });
    });
    apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accentColor: key }),
    }).catch(() => {});
  },

  setTheme: (theme) => {
    set((state) => {
      state.theme = theme;
      saveSettings({ ...getAllSettings(get), theme });
    });
    apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    }).catch(() => {});
  },

  setIconSize: (size) => {
    set((state) => {
      state.iconSize = size;
      saveSettings({ ...getAllSettings(get), iconSize: size });
    });
    apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iconSize: size }),
    }).catch(() => {});
  },

  setHandedness: (handedness) => {
    set((state) => {
      state.handedness = handedness;
      saveSettings({ ...getAllSettings(get), handedness });
    });
    apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handedness }),
    }).catch(() => {});
  },

  setWindowSize: (windowSize) => {
    set((state) => {
      state.windowSize = windowSize;
      saveSettings({ ...getAllSettings(get), windowSize });
    });
    apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowSize }),
    }).catch(() => {});
  },
});
