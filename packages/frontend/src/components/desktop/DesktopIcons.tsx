/**
 * DesktopIcons - Desktop app icons and shortcuts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDesktopStore } from '@/store';
import { apiFetch, resolveAssetUrl } from '@/lib/api';
import type { DesktopShortcut, OSAction } from '@yaar/shared';
import { extractAppId } from '@yaar/shared';
import type { ShortcutContextTarget } from '@/store/types';
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
  hasConfig: boolean;
  run?: string;
  variant?: 'standard' | 'widget' | 'panel';
  dockEdge?: 'top' | 'bottom';
  frameless?: boolean;
  windowStyle?: Record<string, string | number>;
}

interface DesktopIconsProps {
  selectedAppIds: Set<string>;
  sendMessage: (msg: string) => void;
  showShortcutContextMenu: (x: number, y: number, shortcut: ShortcutContextTarget) => void;
}

export function DesktopIcons({
  selectedAppIds,
  sendMessage,
  showShortcutContextMenu,
}: DesktopIconsProps) {
  const appsVersion = useDesktopStore((s) => s.appsVersion);
  const appBadges = useDesktopStore((s) => s.appBadges);
  const shortcuts = useDesktopStore((s) => s.shortcuts);

  const [apps, setApps] = useState<AppInfo[]>([]);
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

  // Fetch shortcuts on mount and when appsVersion changes (after deploy/install/delete)
  useEffect(() => {
    async function fetchShortcuts() {
      try {
        const response = await apiFetch('/api/shortcuts');
        if (response.ok) {
          const data = await response.json();
          useDesktopStore.getState().setShortcuts(data.shortcuts || []);
        }
      } catch (err) {
        console.error('Failed to fetch shortcuts:', err);
      }
    }
    fetchShortcuts();
  }, [appsVersion]);

  const handleShortcutClick = useCallback(
    (shortcut: DesktopShortcut) => {
      if (cooldownId === shortcut.id) return;
      startCooldown(shortcut.id);

      // App shortcuts: resolve yaar://apps/{appId} or legacy type='app'
      const appId = extractAppId(shortcut.target);
      if (appId) {
        // Inline skill instructions (ad-hoc skill shortcuts)
        if (shortcut.skill) {
          sendMessage(
            `<ui:click>skill: ${shortcut.label}</ui:click>\n<skill>\n${shortcut.skill}\n</skill>`,
          );
          return;
        }

        const app = apps.find((a) => a.id === appId);
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
            const content = { renderer: 'iframe' as const, data: app.run };
            store.applyActions([
              {
                type: 'window.create',
                windowId: app.id,
                title: app.name,
                bounds: { x: 100, y: 100, w: 500, h: 400 },
                content,
                ...(app.variant && app.variant !== 'standard' ? { variant: app.variant } : {}),
                ...(app.dockEdge ? { dockEdge: app.dockEdge } : {}),
                ...(app.frameless ? { frameless: true } : {}),
                ...(app.windowStyle ? { windowStyle: app.windowStyle } : {}),
              },
            ]);
            // Sync window creation to backend so WindowStateRegistry knows about it
            useDesktopStore.setState((s) => ({
              pendingInteractions: [
                ...s.pendingInteractions,
                {
                  type: 'window.create' as const,
                  timestamp: Date.now(),
                  windowId: app.id,
                  windowTitle: app.name,
                  monitorId,
                  bounds: { x: 100, y: 100, w: 500, h: 400 },
                  content,
                  ...(app.variant && app.variant !== 'standard' ? { variant: app.variant } : {}),
                  ...(app.dockEdge ? { dockEdge: app.dockEdge } : {}),
                  ...(app.frameless ? { frameless: true } : {}),
                  ...(app.windowStyle ? { windowStyle: app.windowStyle } : {}),
                },
              ],
            }));
          }
          return;
        }
        sendMessage(`<ui:click>app: ${appId}</ui:click>`);
        return;
      }

      // osActions shortcuts: execute directly
      if (shortcut.osActions && shortcut.osActions.length > 0) {
        useDesktopStore.getState().applyActions(shortcut.osActions);
        return;
      }

      // URL or other: send to AI
      sendMessage(`<ui:click>shortcut: ${shortcut.id}, target: ${shortcut.target}</ui:click>`);
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
      {shortcuts.map((shortcut) => {
        const appId = extractAppId(shortcut.target);
        return (
          <button
            key={shortcut.id}
            className={`${styles.desktopIcon}${selectedAppIds.has(shortcut.id) ? ` ${styles.desktopIconSelected}` : ''}`}
            data-shortcut-id={shortcut.id}
            {...(appId ? { 'data-app-id': appId } : {})}
            onClick={() => handleShortcutClick(shortcut)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              showShortcutContextMenu(e.clientX, e.clientY, {
                id: shortcut.id,
                label: shortcut.label,
                target: shortcut.target,
              });
            }}
            disabled={cooldownId === shortcut.id}
            draggable={!!appId}
            onDragStart={
              appId
                ? (e) => {
                    e.dataTransfer.setData('application/x-yaar-app', appId);
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
              {appId && appBadges[appId] > 0 && (
                <span className={styles.badge}>
                  {appBadges[appId] > 99 ? '99+' : appBadges[appId]}
                </span>
              )}
              {!appId && <span className={styles.shortcutArrow} />}
            </span>
            <span className={styles.iconLabel}>{shortcut.label}</span>
          </button>
        );
      })}
    </div>
  );
}
