/**
 * DesktopIcons - Desktop app icons, shortcuts, and folders.
 *
 * Shortcuts with the same `folderId` are grouped into an expandable folder.
 * The folderId value is used as the folder label. Folder icon is a 2x2
 * mini-grid of the first 4 child icons (iPhone-style).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDesktopStore } from '@/store';
import { apiFetch, resolveAssetUrl } from '@/lib/api';
import { registerLocalToastAction } from '@/lib/localToastActions';
import type { DesktopShortcut, OSAction } from '@yaar/shared';
import { extractAppId } from '@yaar/shared';
import { toWindowKey } from '@/store/helpers';
import { launchAppWindow, recordOpened, type InstalledApp } from '@/store/iframe-bridge';
import styles from '@/styles/desktop/DesktopSurface.module.css';

/** App info from /api/apps endpoint */
interface AppInfo extends InstalledApp {
  description?: string;
  icon?: string;
  iconType?: 'emoji' | 'image';
  hasConfig: boolean;
  /** From the app's protocol manifest — only `keybindings` is read here. */
  protocol?: { keybindings?: Record<string, string> };
}

interface DesktopIconsProps {
  selectedAppIds: Set<string>;
  sendMessage: (msg: string) => void;
}

/** A folder derived from shortcuts sharing the same folderId. */
interface DerivedFolder {
  folderId: string;
  children: DesktopShortcut[];
  /** Earliest createdAt among children — used for sort order. */
  createdAt: number;
}

export function DesktopIcons({ selectedAppIds, sendMessage }: DesktopIconsProps) {
  const { t } = useTranslation();
  const appsVersion = useDesktopStore((s) => s.appsVersion);
  const appBadges = useDesktopStore((s) => s.appBadges);
  const shortcuts = useDesktopStore((s) => s.shortcuts);

  const [apps, setApps] = useState<AppInfo[]>([]);
  const [onboardingCompleted, setOnboardingCompleted] = useState(true);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // Double-click prevention: track which icon is in cooldown
  const [cooldownId, setCooldownId] = useState<string | null>(null);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(cooldownTimer.current), []);

  const startCooldown = useCallback((id: string) => {
    setCooldownId(id);
    clearTimeout(cooldownTimer.current);
    cooldownTimer.current = setTimeout(() => setCooldownId(null), 1000);
  }, []);

  // Fetch available apps on mount and when appsVersion changes (after deploy).
  // `loadState` separates "still fetching" and "the fetch failed" from "you really
  // have no shortcuts" — all three used to render as an empty desktop, so a network
  // failure was indistinguishable from an intentionally bare one.
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadNonce, setReloadNonce] = useState(0);
  const fetchedVersionRef = useRef<number | null>(null);
  useEffect(() => {
    if (fetchedVersionRef.current === appsVersion && reloadNonce === 0) return;
    fetchedVersionRef.current = appsVersion;
    async function fetchApps() {
      try {
        const response = await apiFetch('/api/apps');
        if (!response.ok) throw new Error(`/api/apps responded ${response.status}`);
        {
          const data = await response.json();
          const list: AppInfo[] = data.apps || [];
          setApps(list);
          // The shell needs each app's declared combos synchronously when a reserved
          // shortcut fires (`resolveCloseTopWindow`), and this fetch is the one place
          // that already reads them. Asking the app's iframe at keypress time would be
          // a postMessage round-trip inside a handler that must decide now.
          useDesktopStore
            .getState()
            .setAppKeybindings(
              Object.fromEntries(
                list
                  .map((app) => [app.id, Object.keys(app.protocol?.keybindings ?? {})] as const)
                  .filter(([, combos]) => combos.length > 0),
              ),
            );
          setOnboardingCompleted(!!data.onboardingCompleted);
          if (data.userName && data.userName !== useDesktopStore.getState().userName) {
            useDesktopStore.getState().setUserName(data.userName);
          }
          if (data.language && data.language !== useDesktopStore.getState().language) {
            useDesktopStore.getState().applyServerLanguage(data.language);
          }
          // Apply appearance settings from server if present
          const appearance: Record<string, string> = {};
          if (data.wallpaper) appearance.wallpaper = data.wallpaper;
          if (data.accentColor) appearance.accentColor = data.accentColor;
          if (data.iconSize) appearance.iconSize = data.iconSize;
          if (data.theme) appearance.theme = data.theme;
          if (data.handedness) appearance.handedness = data.handedness;
          if (data.windowSize) appearance.windowSize = data.windowSize;
          if (Object.keys(appearance).length > 0) {
            useDesktopStore.getState().applyServerSettings(appearance);
          }
        }
        setLoadState('ready');
      } catch (err) {
        console.error('Failed to fetch apps:', err);
        setLoadState('error');
      }
    }
    fetchApps();
  }, [appsVersion, reloadNonce]);

  // Fetch shortcuts on mount and when appsVersion changes (after deploy/install/delete)
  useEffect(() => {
    async function fetchShortcuts() {
      try {
        const response = await apiFetch('/api/shortcuts');
        if (!response.ok) throw new Error(`/api/shortcuts responded ${response.status}`);
        const data = await response.json();
        useDesktopStore.getState().setShortcuts(data.shortcuts || []);
      } catch (err) {
        console.error('Failed to fetch shortcuts:', err);
        setLoadState('error');
      }
    }
    fetchShortcuts();
  }, [appsVersion, reloadNonce]);

  const retryLoad = useCallback(() => {
    setLoadState('loading');
    setReloadNonce((n) => n + 1);
  }, []);

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
            // A failed launch opens nothing (see `launchAppWindow`), so it has to fail
            // visibly here and offer a retry — on the monitor the icon was clicked on.
            const launch = () => {
              launchAppWindow(app, { monitorId })
                .then((opened) => recordOpened(opened))
                .catch((err) => {
                  console.error(`Failed to open "${app.name}":`, err);
                  const eventId = `app-launch-retry-${app.id}-${Date.now()}`;
                  registerLocalToastAction(eventId, launch);
                  useDesktopStore.getState().applyActions([
                    {
                      type: 'toast.show',
                      id: eventId,
                      message: `Couldn't open "${app.name}" — the session may have expired.`,
                      variant: 'error',
                      action: { label: 'Retry', eventId },
                      duration: 10000,
                    },
                  ]);
                });
            };
            launch();
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

  const toggleFolder = useCallback((folderId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  // Derive folders from shortcuts that share a folderId
  const renderItems = useMemo(() => {
    const loose: DesktopShortcut[] = [];
    const folderMap: Record<string, DerivedFolder> = {};

    for (const s of shortcuts) {
      if (s.folderId) {
        if (!folderMap[s.folderId]) {
          folderMap[s.folderId] = { folderId: s.folderId, children: [], createdAt: s.createdAt };
        }
        folderMap[s.folderId].children.push(s);
        // Folder position = earliest child
        if (s.createdAt < folderMap[s.folderId].createdAt) {
          folderMap[s.folderId].createdAt = s.createdAt;
        }
      } else {
        loose.push(s);
      }
    }

    const items: Array<
      { type: 'shortcut'; data: DesktopShortcut } | { type: 'folder'; data: DerivedFolder }
    > = [];
    for (const s of loose) items.push({ type: 'shortcut', data: s });
    for (const f of Object.values(folderMap)) items.push({ type: 'folder', data: f });
    items.sort((a, b) => a.data.createdAt - b.data.createdAt);
    return items;
  }, [shortcuts]);

  const renderShortcutButton = (shortcut: DesktopShortcut, inFolder = false) => {
    const appId = extractAppId(shortcut.target);
    return (
      <button
        key={shortcut.id}
        className={`${styles.desktopIcon}${inFolder ? ` ${styles.folderChildIcon}` : ''}${selectedAppIds.has(shortcut.id) ? ` ${styles.desktopIconSelected}` : ''}`}
        data-shortcut-id={shortcut.id}
        {...(appId ? { 'data-app-id': appId } : {})}
        onClick={() => handleShortcutClick(shortcut)}
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
            <span className={styles.badge}>{appBadges[appId] > 99 ? '99+' : appBadges[appId]}</span>
          )}
          {!appId && <span className={styles.shortcutArrow} />}
        </span>
        <span className={styles.iconLabel}>{shortcut.label}</span>
      </button>
    );
  };

  const renderFolder = (folder: DerivedFolder) => {
    const isExpanded = expandedFolders.has(folder.folderId);
    const { children } = folder;

    return (
      <div key={folder.folderId} className={styles.folderContainer}>
        <button
          className={`${styles.desktopIcon} ${styles.folderIcon}`}
          onClick={() => toggleFolder(folder.folderId)}
        >
          <span className={styles.iconWrapper}>
            <span className={styles.folderIconGrid}>
              {children.slice(0, 4).map((s) => (
                <span key={s.id} className={styles.folderMiniIcon}>
                  {s.iconType === 'image' ? (
                    <img src={resolveAssetUrl(s.icon)} alt="" className={styles.folderMiniImg} />
                  ) : (
                    s.icon || '🔗'
                  )}
                </span>
              ))}
            </span>
            <span className={styles.folderBadge}>{children.length}</span>
          </span>
          <span className={styles.iconLabel}>{folder.folderId}</span>
        </button>
        {isExpanded && (
          <div className={styles.folderExpanded}>
            {children.map((s) => renderShortcutButton(s, true))}
          </div>
        )}
      </div>
    );
  };

  if (loadState === 'error' && renderItems.length === 0) {
    return (
      <div className={styles.desktopIcons}>
        <div className={styles.iconsError}>
          <span className={styles.iconsErrorText}>{t('desktop.iconsLoadFailed')}</span>
          <button className={styles.iconsRetryButton} onClick={retryLoad}>
            {t('desktop.retry')}
          </button>
        </div>
      </div>
    );
  }

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
      {/* Desktop shortcuts and folders */}
      {renderItems.map((item) =>
        item.type === 'folder' ? renderFolder(item.data) : renderShortcutButton(item.data),
      )}
    </div>
  );
}
