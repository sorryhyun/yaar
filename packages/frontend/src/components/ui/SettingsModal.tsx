/**
 * SettingsModal - Modal for user preferences (name, language).
 */
import { useDesktopStore } from '@/store';
import styles from '@/styles/ui/SettingsModal.module.css';

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
  const toggleSettingsModal = useDesktopStore((s) => s.toggleSettingsModal);
  const userName = useDesktopStore((s) => s.userName);
  const language = useDesktopStore((s) => s.language);
  const setUserName = useDesktopStore((s) => s.setUserName);
  const setLanguage = useDesktopStore((s) => s.setLanguage);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      toggleSettingsModal();
    }
  };

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 className={styles.title}>Settings</h2>
          <button className={styles.closeButton} onClick={toggleSettingsModal}>
            &times;
          </button>
        </div>
        <div className={styles.content}>
          <div className={styles.field}>
            <label className={styles.label}>Name</label>
            <input
              className={styles.input}
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="Enter your name"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Language</label>
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
        </div>
      </div>
    </div>
  );
}
