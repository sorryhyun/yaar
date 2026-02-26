/**
 * DesktopIcons - Desktop app icons and shortcuts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDesktopStore } from '@/store';
import { apiFetch, resolveAssetUrl } from '@/lib/api';
import type { DesktopShortcut, OSAction } from '@yaar/shared';
import { toWindowKey } from '@/store/helpers';
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
  run?: string;
  variant?: 'standard' | 'widget' | 'panel';
  dockEdge?: 'top' | 'bottom';
  frameless?: boolean;
  windowStyle?: Record<string, string | number>;
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

  const handleShortcutClick = useCallback(
    (shortcut: DesktopShortcut) => {
      if (cooldownId === shortcut.id) return;
      startCooldown(shortcut.id);

      // App shortcuts: use app metadata for smart handling
      if (shortcut.type === 'app') {
        const app = apps.find((a) => a.id === shortcut.target);
        if (app?.run) {
          const store = useDesktopStore.getState();
          const monitorId = store.activeMonitorId;
          const key = toWindowKey(monitorId, app.id);
          const existing = store.windows[key];
          if (existing) {
            const actions: OSAction[] = [];
            if (existing.minimized) actions.push({ type: 'window.restore', windowId: app.id });
            actions.push({ type: 'window.focus', windowId: app.id });
            store.applyActions(actions);
          } else {
            store.applyActions([
              {
                type: 'window.create',
                windowId: app.id,
                title: app.name,
                bounds: { x: 100, y: 100, w: 500, h: 400 },
                content: { renderer: 'iframe', data: app.run },
                ...(app.variant && app.variant !== 'standard' ? { variant: app.variant } : {}),
                ...(app.dockEdge ? { dockEdge: app.dockEdge } : {}),
                ...(app.frameless ? { frameless: true } : {}),
                ...(app.windowStyle ? { windowStyle: app.windowStyle } : {}),
              },
            ]);
          }
          return;
        }
        sendMessage(`<ui:click>app: ${shortcut.target}</ui:click>`);
        return;
      }

      // Other shortcuts: use osActions or send to AI
      if (shortcut.osActions && shortcut.osActions.length > 0) {
        useDesktopStore.getState().applyActions(shortcut.osActions);
        return;
      }
      sendMessage(
        `<ui:click>shortcut: ${shortcut.id}, type: ${shortcut.type}, target: ${shortcut.target}</ui:click>`,
      );
    },
    [sendMessage, cooldownId, startCooldown, apps],
  );

  return (
    <div className={styles.desktopIcons}>
      {/* Onboarding icon (shown until onboarding is completed) */}
      {!onboardingCompleted && (
        <button
          className={styles.desktopIcon}
          onClick={() => sendMessage('<ui:click>app: onboarding</ui:click>')}
          disabled={cooldownId === 'onboarding'}
        >
          <span className={styles.iconImage}>🚀</span>
          <span className={styles.iconLabel}>Start</span>
        </button>
      )}
      {/* Desktop shortcuts (includes app shortcuts) */}
      {mergedShortcuts.map((shortcut) => (
        <button
          key={shortcut.id}
          className={`${styles.desktopIcon}${selectedAppIds.has(shortcut.id) ? ` ${styles.desktopIconSelected}` : ''}`}
          data-shortcut-id={shortcut.id}
          {...(shortcut.type === 'app' ? { 'data-app-id': shortcut.target } : {})}
          onClick={() => handleShortcutClick(shortcut)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            showContextMenu(e.clientX, e.clientY);
          }}
          disabled={cooldownId === shortcut.id}
          draggable={shortcut.type === 'app'}
          onDragStart={
            shortcut.type === 'app'
              ? (e) => {
                  e.dataTransfer.setData('application/x-yaar-app', shortcut.target);
                  e.dataTransfer.effectAllowed = 'link';
                }
              : undefined
          }
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
            {shortcut.type === 'app' && appBadges[shortcut.target] > 0 && (
              <span className={styles.badge}>
                {appBadges[shortcut.target] > 99 ? '99+' : appBadges[shortcut.target]}
              </span>
            )}
            {shortcut.type !== 'app' && <span className={styles.shortcutArrow} />}
          </span>
          <span className={styles.iconLabel}>{shortcut.label}</span>
        </button>
      ))}
    </div>
  );
}
