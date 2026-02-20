/**
 * DesktopIcons - Desktop app icons and shortcuts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDesktopStore } from '@/store';
import { apiFetch, resolveAssetUrl } from '@/lib/api';
import type { DesktopShortcut } from '@yaar/shared';
import styles from '@/styles/desktop/DesktopSurface.module.css';

/** App info from /api/apps endpoint */
interface AppInfo {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  iconType?: 'emoji' | 'image';
  hasSkill: boolean;
  hasCredentials: boolean;
  hidden?: boolean;
}

interface DesktopIconsProps {
  selectedAppIds: Set<string>;
  sendMessage: (msg: string) => void;
  showContextMenu: (x: number, y: number, windowId?: string) => void;
}

export function DesktopIcons({ selectedAppIds, sendMessage, showContextMenu }: DesktopIconsProps) {
  const appsVersion = useDesktopStore((s) => s.appsVersion);
  const appBadges = useDesktopStore((s) => s.appBadges);
  const storeShortcuts = useDesktopStore((s) => s.shortcuts);

  const [apps, setApps] = useState<AppInfo[]>([]);
  const [shortcuts, setShortcuts] = useState<DesktopShortcut[]>([]);
  const [onboardingCompleted, setOnboardingCompleted] = useState(true);

  // Double-click prevention: track which icon is in cooldown
  const [cooldownId, setCooldownId] = useState<string | null>(null);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(cooldownTimer.current), []);

  const startCooldown = useCallback((id: string) => {
    setCooldownId(id);
    clearTimeout(cooldownTimer.current);
    cooldownTimer.current = setTimeout(() => setCooldownId(null), 1000);
  }, []);

  // Fetch available apps on mount and when appsVersion changes (after deploy)
  const fetchedVersionRef = useRef(-1);
  useEffect(() => {
    if (fetchedVersionRef.current === appsVersion) return;
    fetchedVersionRef.current = appsVersion;
    async function fetchApps() {
      try {
        const response = await apiFetch('/api/apps');
        if (response.ok) {
          const data = await response.json();
          setApps(data.apps || []);
          setOnboardingCompleted(!!data.onboardingCompleted);
          if (data.language && data.language !== useDesktopStore.getState().language) {
            useDesktopStore.getState().applyServerLanguage(data.language);
          }
        }
      } catch (err) {
        console.error('Failed to fetch apps:', err);
      }
    }
    fetchApps();
  }, [appsVersion]);

  // Fetch shortcuts on mount
  useEffect(() => {
    async function fetchShortcuts() {
      try {
        const response = await apiFetch('/api/shortcuts');
        if (response.ok) {
          const data = await response.json();
          setShortcuts(data.shortcuts || []);
        }
      } catch (err) {
        console.error('Failed to fetch shortcuts:', err);
      }
    }
    fetchShortcuts();
  }, []);

  // Merge fetched shortcuts with store shortcuts (store takes precedence for real-time updates)
  const mergedShortcuts = useMemo(() => {
    const map = new Map<string, DesktopShortcut>();
    for (const s of shortcuts) map.set(s.id, s);
    for (const s of storeShortcuts) map.set(s.id, s);
    return Array.from(map.values());
  }, [shortcuts, storeShortcuts]);

  const handleAppClick = useCallback(
    (appId: string) => {
      if (cooldownId === appId) return;
      startCooldown(appId);
      sendMessage(`<ui:click>app: ${appId}</ui:click>`);
    },
    [sendMessage, cooldownId, startCooldown],
  );

  const handleShortcutClick = useCallback(
    (shortcut: DesktopShortcut) => {
      if (shortcut.osActions && shortcut.osActions.length > 0) {
        useDesktopStore.getState().applyActions(shortcut.osActions);
        return;
      }
      if (cooldownId === shortcut.id) return;
      startCooldown(shortcut.id);
      sendMessage(
        `<ui:click>shortcut: ${shortcut.id}, type: ${shortcut.type}, target: ${shortcut.target}</ui:click>`,
      );
    },
    [sendMessage, cooldownId, startCooldown],
  );

  return (
    <div className={styles.desktopIcons}>
      {/* Onboarding icon (shown until onboarding is completed) */}
      {!onboardingCompleted && (
        <button
          className={styles.desktopIcon}
          onClick={() => handleAppClick('onboarding')}
          disabled={cooldownId === 'onboarding'}
        >
          <span className={styles.iconImage}>🚀</span>
          <span className={styles.iconLabel}>Start</span>
        </button>
      )}
      {/* Dynamic app icons (hidden apps filtered out) */}
      {apps
        .filter((a) => !a.hidden)
        .map((app) => (
          <button
            key={app.id}
            className={`${styles.desktopIcon}${selectedAppIds.has(app.id) ? ` ${styles.desktopIconSelected}` : ''}`}
            data-app-id={app.id}
            onClick={() => handleAppClick(app.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              showContextMenu(e.clientX, e.clientY);
            }}
            disabled={cooldownId === app.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-yaar-app', app.id);
              e.dataTransfer.effectAllowed = 'link';
            }}
          >
            <span className={styles.iconWrapper}>
              {app.iconType === 'image' ? (
                <img
                  className={styles.iconImg}
                  src={resolveAssetUrl(app.icon!)}
                  alt={app.name}
                  draggable={false}
                />
              ) : (
                <span className={styles.iconImage}>{app.icon || '📦'}</span>
              )}
              {appBadges[app.id] > 0 && (
                <span className={styles.badge}>
                  {appBadges[app.id] > 99 ? '99+' : appBadges[app.id]}
                </span>
              )}
            </span>
            <span className={styles.iconLabel}>{app.name}</span>
          </button>
        ))}
      {/* Desktop shortcuts */}
      {mergedShortcuts.map((shortcut) => (
        <button
          key={shortcut.id}
          className={`${styles.desktopIcon}${selectedAppIds.has(shortcut.id) ? ` ${styles.desktopIconSelected}` : ''}`}
          data-shortcut-id={shortcut.id}
          onClick={() => handleShortcutClick(shortcut)}
          disabled={cooldownId === shortcut.id}
        >
          <span className={styles.iconWrapper}>
            {shortcut.iconType === 'image' ? (
              <img
                className={styles.iconImg}
                src={resolveAssetUrl(shortcut.icon)}
                alt={shortcut.label}
                draggable={false}
              />
            ) : (
              <span className={styles.iconImage}>{shortcut.icon || '🔗'}</span>
            )}
            <span className={styles.shortcutArrow} />
          </span>
          <span className={styles.iconLabel}>{shortcut.label}</span>
        </button>
      ))}
    </div>
  );
}
