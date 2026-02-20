/**
 * SettingsModal - Modal for user preferences (name, language, domain settings, appearance).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDesktopStore } from '@/store';
import { WALLPAPER_PRESETS, ACCENT_PRESETS, ICON_SIZE_PRESETS } from '@/constants/appearance';
import type { IconSizeKey } from '@/constants/appearance';
import styles from '@/styles/overlays/SettingsModal.module.css';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ko', label: '한국어' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
];

export function SettingsModal() {
  const { t } = useTranslation();
  const toggleSettingsModal = useDesktopStore((s) => s.toggleSettingsModal);
  const userName = useDesktopStore((s) => s.userName);
  const language = useDesktopStore((s) => s.language);
  const setUserName = useDesktopStore((s) => s.setUserName);
  const setLanguage = useDesktopStore((s) => s.setLanguage);
  const wallpaper = useDesktopStore((s) => s.wallpaper);
  const accentColor = useDesktopStore((s) => s.accentColor);
  const iconSize = useDesktopStore((s) => s.iconSize);
  const setWallpaper = useDesktopStore((s) => s.setWallpaper);
  const setAccentColor = useDesktopStore((s) => s.setAccentColor);
  const setIconSize = useDesktopStore((s) => s.setIconSize);

  const [allowAllDomains, setAllowAllDomains] = useState(false);
  // Track whether the current wallpaper is a solid (custom) color
  const isCustomSolid = !WALLPAPER_PRESETS.some((p) => p.key === wallpaper);
  const [solidColor, setSolidColor] = useState(isCustomSolid ? wallpaper : '#2a2a3e');

  useEffect(() => {
    fetch('/api/domains')
      .then((r) => r.json())
      .then((data: { allowAllDomains: boolean }) => {
        setAllowAllDomains(data.allowAllDomains);
      })
      .catch(() => {});
  }, []);

  const handleToggleAllowAll = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.checked;
    setAllowAllDomains(value);
    fetch('/api/domains', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowAllDomains: value }),
    }).catch(() => {
      setAllowAllDomains(!value);
    });
  }, []);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      toggleSettingsModal();
    }
  };

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 className={styles.title}>{t('settings.title')}</h2>
          <button className={styles.closeButton} onClick={toggleSettingsModal}>
            &times;
          </button>
        </div>
        <div className={styles.scrollContent}>
          <div className={styles.field}>
            <label className={styles.label}>{t('settings.name.label')}</label>
            <input
              className={styles.input}
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder={t('settings.name.placeholder')}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>{t('settings.language.label')}</label>
            <select
              className={styles.select}
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.divider} />
          <div className={styles.field}>
            <label className={styles.toggleRow}>
              <span className={styles.toggleLabel}>
                <span className={styles.label}>{t('settings.domains.label')}</span>
                <span className={styles.subtitle}>{t('settings.domains.description')}</span>
              </span>
              <input
                type="checkbox"
                className={styles.toggle}
                checked={allowAllDomains}
                onChange={handleToggleAllowAll}
              />
            </label>
          </div>

          {/* Wallpaper */}
          <div className={styles.divider} />
          <div className={styles.field}>
            <span className={styles.label}>{t('settings.wallpaper.label')}</span>
            <div className={styles.swatchRow}>
              {WALLPAPER_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  className={`${styles.wallpaperSwatch}${wallpaper === preset.key ? ` ${styles.wallpaperSwatchActive}` : ''}`}
                  style={{ background: preset.css }}
                  title={preset.label}
                  onClick={() => setWallpaper(preset.key)}
                />
              ))}
              <input
                type="color"
                className={styles.solidColorPicker}
                value={solidColor}
                title={t('settings.wallpaper.solidColor')}
                onChange={(e) => {
                  setSolidColor(e.target.value);
                  setWallpaper(e.target.value);
                }}
              />
            </div>
          </div>

          {/* Accent Color */}
          <div className={styles.divider} />
          <div className={styles.field}>
            <span className={styles.label}>{t('settings.accentColor.label')}</span>
            <div className={styles.accentRow}>
              {ACCENT_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  className={`${styles.accentDot}${accentColor === preset.key ? ` ${styles.accentDotActive}` : ''}`}
                  style={{ background: preset.color }}
                  title={preset.key}
                  onClick={() => setAccentColor(preset.key)}
                />
              ))}
            </div>
          </div>

          {/* Icon Size */}
          <div className={styles.divider} />
          <div className={styles.field}>
            <span className={styles.label}>{t('settings.iconSize.label')}</span>
            <div className={styles.segmentedControl}>
              {ICON_SIZE_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  className={`${styles.segmentButton}${iconSize === preset.key ? ` ${styles.segmentButtonActive}` : ''}`}
                  onClick={() => setIconSize(preset.key as IconSizeKey)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
