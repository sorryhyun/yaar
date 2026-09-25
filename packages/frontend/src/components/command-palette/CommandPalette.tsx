/**
 * CommandPalette - Input for sending messages to the agent.
 *
 * On a phone it is a bottom sheet rather than a fixture. Collapsed it is a handle at
 * the bottom edge — the screen belongs to whatever card is open — and a pull-up on
 * that handle (or a tap) raises the input, the monitor tabs and the window tabs
 * together. The handle is shell DOM sitting at the very bottom, which is what lets
 * the gesture work without an overlay stealing touches from the app above it.
 *
 * The pull-up is a request for the keyboard as much as for the panel. The sheet follows
 * the finger up, as the shade follows it down, and only on touchend does it either open —
 * keyboard included, because that is the last moment a phone will still open one — or
 * fall back; see `lib/palette-sheet`. A pull up from anywhere else on
 * the screen raises it too (`PhoneGestures`): the bottom edge is also the system's, and a
 * pull that starts there keeps bringing up the phone's own navigation bar.
 */
import { useState, useCallback, useEffect, useMemo, useRef, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useIsConnected,
  sendMessage,
  sendWindowMessage,
  interrupt,
} from '@/hooks/useAgentConnection';
import { useShallow } from 'zustand/react/shallow';
import { useDesktopStore, type DesktopStore } from '@/store';
import type { MessageStatus } from '@/store/slices/messageStatusSlice';
import { ContextResetButton } from './ContextResetButton';
import { QrCodeModal } from '../overlays/QrCodeModal';
import { Taskbar } from '../taskbar/Taskbar';
import { MonitorTabs } from '../taskbar/MonitorTabs';
import { apiFetch, isRemoteMode } from '@/lib/api';
import { dragAxis, swipeDirection } from '@/lib/gestures';
import { isComposingKey } from '@/lib/ime';
import { filterImageFiles } from '@/lib/uploadImage';
import {
  PALETTE_SHEET_ID,
  cancelPaletteRaise,
  finishPaletteRaise,
  openPaletteSheetWithKeyboard,
  trackPaletteRaise,
} from '@/lib/palette-sheet';
import styles from '@/styles/command-palette/CommandPalette.module.css';

function statusClass(status: MessageStatus['status']): string {
  if (status === 'failed') return styles.messageStatusFailed;
  if (status === 'unsent') return styles.messageStatusUnsent;
  if (status === 'queued') return styles.messageStatusQueued;
  return styles.messageStatusAccepted;
}

function statusLabel(status: MessageStatus): string {
  if (status.status === 'failed') return status.error ?? 'Message failed';
  // Not "sending". It is not on its way — it is sitting in the outbox waiting for a
  // connection, and it will go out by itself when one comes back.
  if (status.status === 'unsent') return 'Not sent — waiting to reconnect';
  if (status.status === 'queued') return `Queued (position ${status.position})`;
  return 'Accepted';
}

function readFilesAsDataUrls(files: File[]): Promise<string[]> {
  return Promise.all(
    files.map(
      (file) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        }),
    ),
  );
}

/** One `[appId, windowId, title]` triple per open app, first window wins. */
function selectAppWindowFields(state: DesktopStore): string[] {
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const w of Object.values(state.windows)) {
    if (w.appId && !seen.has(w.appId)) {
      seen.add(w.appId);
      fields.push(w.appId, w.id, w.title);
    }
  }
  return fields;
}

export function CommandPalette() {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const [qrCodeOpen, setQrCodeOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const isConnected = useIsConnected();
  const activeAgents = useDesktopStore((state) => state.activeAgents);
  const applyAction = useDesktopStore((state) => state.applyAction);
  const hasDrawing = useDesktopStore((state) => state.hasDrawing);
  const clearDrawing = useDesktopStore((state) => state.clearDrawing);
  const pencilMode = useDesktopStore((state) => state.pencilMode);
  const setPencilMode = useDesktopStore((state) => state.setPencilMode);
  const togglePencilMode = useDesktopStore((state) => state.togglePencilMode);
  const attachedImages = useDesktopStore((state) => state.attachedImages);
  const addAttachedImages = useDesktopStore((state) => state.addAttachedImages);
  const removeAttachedImage = useDesktopStore((state) => state.removeAttachedImage);
  const clearAttachedImages = useDesktopStore((state) => state.clearAttachedImages);
  const messageStatuses = useDesktopStore((state) => state.messageStatuses);
  // Flattened to strings so `useShallow` can compare it: the `windows` map itself gets a
  // new identity on every mousemove of a window drag, and this component is too big to
  // re-render at pointer rate for a list that only changes when an app opens or closes.
  const appWindowFields = useDesktopStore(useShallow(selectAppWindowFields));
  const isMobile = useDesktopStore((state) => state.formFactor === 'mobile');
  const sheetOpen = useDesktopStore((state) => state.paletteSheetOpen);
  const setPaletteSheetOpen = useDesktopStore((state) => state.setPaletteSheetOpen);

  // Only a phone has a sheet to collapse; on a desktop the palette is always on screen.
  const collapsed = isMobile && !sheetOpen;

  // Publish how much of the bottom of the screen the palette occupies, so a phone's
  // full-screen window cards can stop exactly above it — the palette grows with an
  // expanded textarea, attachments, and a status line.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const root = document.documentElement.style;
    const publish = () => {
      // Collapsed, the sheet is translated off the bottom of the screen and the handle
      // is all that is left, so the handle's own height is what a card stops above.
      // Measuring the container would read a rect mid-transition and hand the cards a
      // height that is about to be wrong.
      const handle = handleRef.current;
      const h =
        collapsed && handle
          ? handle.getBoundingClientRect().height
          : Math.max(0, globalThis.innerHeight - el.getBoundingClientRect().top);
      root.setProperty('--palette-h', `${h}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    globalThis.addEventListener('resize', publish);
    return () => {
      observer.disconnect();
      globalThis.removeEventListener('resize', publish);
      root.removeProperty('--palette-h');
    };
  }, [collapsed]);

  // Raising the sheet is a request for the keyboard: the gesture's whole purpose is to
  // get at the input field, and making the user tap the textarea afterwards would undo
  // half of it. Lowering it gives the focus back so the keyboard goes away with it.
  //
  // A sheet raised by a *gesture* is focused by `openPaletteSheetWithKeyboard` instead,
  // inside the touch handler — see there for why. This effect is what catches every other way
  // the sheet can open, and a second focus() on an already-focused textarea is a no-op.
  useEffect(() => {
    if (!isMobile) return;
    if (sheetOpen) textareaRef.current?.focus({ preventScroll: true });
    else {
      textareaRef.current?.blur();
      setIsExpanded(false);
    }
  }, [isMobile, sheetOpen]);

  // Open app windows for @mention dropdown
  const appWindows = useMemo(() => {
    const result: { appId: string; windowId: string; title: string }[] = [];
    for (let i = 0; i < appWindowFields.length; i += 3) {
      const [appId, windowId, title] = appWindowFields.slice(i, i + 3);
      result.push({ appId, windowId, title });
    }
    return result;
  }, [appWindowFields]);

  // Show @mention dropdown when input starts with "@" and no space yet (typing appId)
  const mentionQuery = useMemo(() => {
    const match = input.match(/^@(\S*)$/);
    return match ? match[1] : null;
  }, [input]);

  const mentionMatches = useMemo(() => {
    if (mentionQuery === null) return [];
    if (mentionQuery === '') return appWindows;
    const q = mentionQuery.toLowerCase();
    return appWindows.filter(
      (a) => a.appId.toLowerCase().includes(q) || a.title.toLowerCase().includes(q),
    );
  }, [mentionQuery, appWindows]);

  const selectMention = useCallback((appId: string) => {
    setInput(`@${appId} `);
    setMentionIndex(0);
    textareaRef.current?.focus();
  }, []);

  // Collapse the palette when the user's attention goes elsewhere. Focus alone can't
  // tell us this: clicking into an app iframe never fires a pointer event this document
  // can see, so a window `blur` (which *does* fire when an iframe takes focus) backs up
  // the outside-click listener.
  useEffect(() => {
    if (!isExpanded) return;

    const collapseIfOutside = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setIsExpanded(false);
    };
    const collapseOnFocusLoss = () => {
      if (!containerRef.current?.contains(document.activeElement)) setIsExpanded(false);
    };

    document.addEventListener('pointerdown', collapseIfOutside);
    window.addEventListener('blur', collapseOnFocusLoss);
    return () => {
      document.removeEventListener('pointerdown', collapseIfOutside);
      window.removeEventListener('blur', collapseOnFocusLoss);
    };
  }, [isExpanded]);

  // Derive the most relevant active status to display.
  //
  // Failure outranks everything: a message that will not run is the one thing the user has
  // to know about, and it used to be the one thing they could not see — the chip stayed on
  // "queued" for a message the server had already dropped. `unsent` ranks next: it is a
  // command still sitting in the outbox because the socket was down.
  const activeStatus = useMemo((): MessageStatus | null => {
    const entries = Object.values(messageStatuses);
    if (entries.length === 0) return null;
    return (
      entries.find((e) => e.status === 'failed') ??
      entries.find((e) => e.status === 'unsent') ??
      entries.find((e) => e.status === 'queued') ??
      entries.find((e) => e.status === 'accepted') ??
      null // Don't show 'sent' — avoid flicker for fast responses
    );
  }, [messageStatuses]);

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const imageFiles = filterImageFiles(
        Array.from(e.clipboardData.items, (item) => item.getAsFile()).filter(
          (file): file is File => file !== null,
        ),
      );
      if (imageFiles.length === 0) return;
      e.preventDefault();
      const dataUrls = await readFilesAsDataUrls(imageFiles);
      addAttachedImages(dataUrls);
    },
    [addAttachedImages],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((_e: React.DragEvent) => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const files = filterImageFiles(e.dataTransfer.files);
      if (files.length === 0) return;
      const dataUrls = await readFilesAsDataUrls(files);
      addAttachedImages(dataUrls);
    },
    [addAttachedImages],
  );

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    // Allow sending if there's text OR a drawing/image attached
    if ((!trimmed && !hasDrawing && attachedImages.length === 0) || !isConnected) return;

    // Auto-exit pencil mode on send
    if (pencilMode) setPencilMode(false);

    // @appId prefix → route directly to the app agent
    const atMatch = trimmed.match(/^@(\S+)\s+([\s\S]+)$/);
    if (atMatch) {
      const [, targetAppId, message] = atMatch;
      const windows = useDesktopStore.getState().windows;
      const appWindow = Object.values(windows).find((w) => w.appId === targetAppId);
      if (appWindow) {
        sendWindowMessage(appWindow.id, message);
        setInput('');
        return;
      }
      // No matching open app window — fall through to monitor
    }

    sendMessage(trimmed);
    setInput('');
  }, [input, isConnected, hasDrawing, attachedImages.length, pencilMode, setPencilMode]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Let the IME consume keys while a syllable is still composing
      if (isComposingKey(e)) return;

      // @mention dropdown navigation
      if (mentionMatches.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setMentionIndex((i) => (i + 1) % mentionMatches.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          selectMention(mentionMatches[mentionIndex].appId);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setInput('');
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === 'Escape') {
        setIsExpanded(false);
        const agentCount = Object.keys(activeAgents).length;
        if (agentCount > 0) {
          interrupt();
          applyAction({
            type: 'toast.show',
            id: `interrupt-${Date.now()}`,
            message:
              agentCount === 1
                ? t('commandPalette.toast.agentStopped')
                : t('commandPalette.toast.agentsStopped', { count: agentCount }),
            variant: 'info',
          });
        }
      }
    },
    [handleSubmit, activeAgents, applyAction, t, mentionMatches, mentionIndex, selectMention],
  );

  // Pull-up / pull-down on the handle. The handle is the bottom edge of the screen when
  // the sheet is down and the top edge of the sheet when it is up, so one element carries
  // both directions and neither needs an overlay over the app. The pull up follows the
  // finger and decides on the lift (`lib/palette-sheet`); the push down just decides.
  const handleDrag = useRef<{
    x: number;
    y: number;
    at: number;
    axis: 'x' | 'y' | null;
    /** Down when the touch landed, so an upward drag is a pull on the collapsed sheet. */
    raising: boolean;
  } | null>(null);

  const onHandleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    handleDrag.current = touch
      ? {
          x: touch.clientX,
          y: touch.clientY,
          at: performance.now(),
          axis: null,
          raising: !useDesktopStore.getState().paletteSheetOpen,
        }
      : null;
  }, []);

  const onHandleTouchMove = useCallback((e: React.TouchEvent) => {
    const drag = handleDrag.current;
    const touch = e.touches[0];
    if (!drag?.raising || !touch) return;
    const dy = touch.clientY - drag.y;
    drag.axis ??= dragAxis(touch.clientX - drag.x, dy);
    // The sheet moves and nothing else: no store change until the lift, so nothing can
    // focus the textarea — and raise the keyboard — while the finger is still deciding.
    if (drag.axis === 'y') trackPaletteRaise(-dy);
  }, []);

  const onHandleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const drag = handleDrag.current;
      handleDrag.current = null;
      const touch = e.changedTouches[0];
      if (!drag || !touch) return;
      const dx = touch.clientX - drag.x;
      const dy = touch.clientY - drag.y;
      if (drag.raising && drag.axis === 'y') {
        // The drag has already decided, either way. Without this the browser follows it
        // with a click, which the tap handler would read as a request to open.
        e.preventDefault();
        finishPaletteRaise(-dy, performance.now() - drag.at);
        return;
      }
      if (drag.axis === 'x') return;
      // A flick the browser coalesced into a start and an end — nothing to have followed —
      // or a push down on the raised sheet.
      const direction = swipeDirection(dx, dy);
      if (direction !== 'up' && direction !== 'down') return;
      e.preventDefault();
      if (direction === 'up') openPaletteSheetWithKeyboard();
      else setPaletteSheetOpen(false);
    },
    [setPaletteSheetOpen],
  );

  const onHandleTouchCancel = useCallback(() => {
    if (handleDrag.current?.raising) cancelPaletteRaise();
    handleDrag.current = null;
  }, []);

  const pencilButton = (
    <button
      className={styles.pencilButton}
      onClick={togglePencilMode}
      title={
        pencilMode
          ? t('commandPalette.tooltip.pencilExit')
          : t('commandPalette.tooltip.pencilEnter')
      }
      data-active={pencilMode}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 20 20"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M14.167 2.5C14.3856 2.28141 14.6454 2.10753 14.9314 1.98775C15.2173 1.86797 15.5238 1.80469 15.8337 1.80141C16.1435 1.79813 16.4513 1.85491 16.7398 1.96858C17.0283 2.08225 17.2917 2.25055 17.5149 2.46381C17.7382 2.67707 17.917 2.9311 18.0398 3.21256C18.1627 3.49403 18.2275 3.79715 18.2302 4.10408C18.233 4.41102 18.1738 4.71528 18.0559 4.99897C17.938 5.28267 17.764 5.53993 17.5437 5.755L6.25036 17.0833L1.66699 18.3333L2.91699 13.75L14.167 2.5Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );

  return (
    <>
      {qrCodeOpen && <QrCodeModal onClose={() => setQrCodeOpen(false)} />}
      {/* The raised sheet's backdrop, as the shade has one: the card behind dims, and a tap
          on it puts the sheet away *instead of* landing on the card. A document-level
          pointerdown used to do the closing, and the same tap went on to press whatever
          was under it — an iframe's forwarded click included. */}
      {isMobile && sheetOpen && (
        <div
          className={styles.sheetBackdrop}
          data-palette-backdrop=""
          onClick={() => setPaletteSheetOpen(false)}
        />
      )}
      <div
        ref={containerRef}
        className={styles.container}
        data-expanded={isExpanded}
        data-collapsed={collapsed || undefined}
        // The palette is the phone's system bar: it stays put while the monitors slide
        // past behind it, and a pull on its handle is its own gesture, not a pan.
        data-no-pan=""
        // What a pull up moves while the finger is down — see `lib/palette-sheet`.
        data-gesture-layer="palette-pull"
      >
        {isMobile && (
          <button
            ref={handleRef}
            className={styles.sheetHandle}
            onClick={() =>
              sheetOpen ? setPaletteSheetOpen(false) : openPaletteSheetWithKeyboard()
            }
            onTouchStart={onHandleTouchStart}
            onTouchMove={onHandleTouchMove}
            onTouchEnd={onHandleTouchEnd}
            onTouchCancel={onHandleTouchCancel}
            aria-expanded={sheetOpen}
            aria-controls={PALETTE_SHEET_ID}
            aria-label={t(sheetOpen ? 'commandPalette.sheet.close' : 'commandPalette.sheet.open')}
          >
            <span className={styles.sheetGrip} />
            {collapsed && (
              <span className={styles.sheetHint}>{t('commandPalette.sheet.hint')}</span>
            )}
          </button>
        )}
        {/* `inert` and not just `hidden`: collapsed, the sheet is still laid out (its own
            height is what the collapse transform is measured against), so without this its
            buttons stay tabbable and its textarea stays focusable off the bottom edge. */}
        <div id={PALETTE_SHEET_ID} inert={collapsed}>
          {hasDrawing && (
            <div className={styles.drawingIndicator}>
              <span className={styles.drawingIcon}>&#9998;</span>
              <span>{t('commandPalette.drawing.attached')}</span>
              <button
                className={styles.clearDrawingButton}
                onClick={clearDrawing}
                title={t('commandPalette.drawing.clear')}
              >
                &times;
              </button>
            </div>
          )}
          {attachedImages.length > 0 && (
            <div className={styles.imageAttachStrip}>
              {attachedImages.map((src, i) => (
                <div key={i} className={styles.imageThumbWrapper}>
                  <img src={src} className={styles.imageThumb} alt={`Attached ${i + 1}`} />
                  <button
                    className={styles.imageThumbRemove}
                    onClick={() => removeAttachedImage(i)}
                    title={t('commandPalette.image.remove')}
                  >
                    &times;
                  </button>
                </div>
              ))}
              {attachedImages.length > 1 && (
                <button className={styles.clearAllImages} onClick={clearAttachedImages}>
                  {t('commandPalette.image.clearAll')}
                </button>
              )}
            </div>
          )}
          {/* Monitor switcher sits above the bar, as its own row — same relationship
            the taskbar row has below it, just on the other side. On a phone both rows
            move into the pull-down shade: down here they would be two strips of a small
            screen stacked on a sheet that is collapsed most of the time. */}
          {!isMobile && <MonitorTabs />}
          <div className={styles.inputRow}>
            {/* Single glass bar: icon cluster, textarea, and Send share one surface. */}
            <div
              className={styles.inputWrapper}
              data-dragover={isDragOver}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className={styles.actionButtons}>
                {isRemoteMode() && (
                  <button
                    className={styles.qrButton}
                    onClick={() => setQrCodeOpen((v) => !v)}
                    title={t('commandPalette.menu.qrCode')}
                    data-active={qrCodeOpen}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 20 20"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <rect
                        x="2"
                        y="2"
                        width="7"
                        height="7"
                        rx="1"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                      <rect
                        x="11"
                        y="2"
                        width="7"
                        height="7"
                        rx="1"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                      <rect
                        x="2"
                        y="11"
                        width="7"
                        height="7"
                        rx="1"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                      <rect x="12" y="12" width="2" height="2" fill="currentColor" />
                      <rect x="16" y="12" width="2" height="2" fill="currentColor" />
                      <rect x="12" y="16" width="2" height="2" fill="currentColor" />
                      <rect x="16" y="16" width="2" height="2" fill="currentColor" />
                      <rect x="4" y="4" width="3" height="3" fill="currentColor" />
                      <rect x="13" y="4" width="3" height="3" fill="currentColor" />
                      <rect x="4" y="13" width="3" height="3" fill="currentColor" />
                    </svg>
                  </button>
                )}
                {/* On a phone this row is under the thumb all session, so the slot the
                    reset held goes to the pen — the more frequent action — and the reset
                    moves up to the pull-down shade, where it takes a deliberate reach. */}
                {isMobile ? pencilButton : <ContextResetButton className={styles.resetButton} />}
                <button
                  className={styles.closeAllButton}
                  onClick={() => {
                    const state = useDesktopStore.getState();
                    const windowIds = Object.keys(state.windows);
                    for (const id of windowIds) state.userCloseWindow(id);
                  }}
                  title={t('commandPalette.tooltip.closeAll')}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 20 20"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M5 5L15 15M15 5L5 15"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
                {!isMobile && pencilButton}
                {/* Opens a native folder picker on the server's machine — never the phone's. */}
                {!isMobile && (
                  <button
                    className={styles.folderButton}
                    onClick={async () => {
                      try {
                        const res = await apiFetch('/api/pick-directory', { method: 'POST' });
                        const data = await res.json();
                        if (data.path) {
                          sendMessage(`<ui:click>mount: ${data.path}</ui:click>`);
                        }
                      } catch {
                        /* dialog failed or cancelled */
                      }
                    }}
                    title={t('commandPalette.tooltip.mountFolder')}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 20 20"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M2.5 5.83333V15.8333C2.5 16.2754 2.67559 16.6993 2.98816 17.0118C3.30072 17.3244 3.72464 17.5 4.16667 17.5H15.8333C16.2754 17.5 16.6993 17.3244 17.0118 17.0118C17.3244 16.6993 17.5 16.2754 17.5 15.8333V8.33333C17.5 7.89131 17.3244 7.46738 17.0118 7.15482C16.6993 6.84226 16.2754 6.66667 15.8333 6.66667H10L8.33333 4.16667H4.16667C3.72464 4.16667 3.30072 4.34226 2.98816 4.65482C2.67559 4.96738 2.5 5.39131 2.5 5.83333Z"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
              </div>

              {mentionMatches.length > 0 && (
                <div className={styles.mentionDropdown}>
                  {mentionMatches.map((app, i) => (
                    <button
                      key={app.appId}
                      className={styles.mentionItem}
                      data-active={i === mentionIndex}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectMention(app.appId);
                      }}
                      onMouseEnter={() => setMentionIndex(i)}
                    >
                      <span className={styles.mentionAppId}>@{app.appId}</span>
                      <span className={styles.mentionTitle}>{app.title}</span>
                    </button>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                data-palette-input=""
                className={styles.input}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setMentionIndex(0);
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onFocus={() => setIsExpanded(true)}
                placeholder={
                  !isConnected
                    ? t('commandPalette.placeholder.connecting')
                    : isExpanded
                      ? t('commandPalette.placeholder.expanded')
                      : t('commandPalette.placeholder.default')
                }
                disabled={!isConnected}
                rows={isExpanded ? 3 : 1}
              />
              <button
                className={styles.sendButton}
                onClick={handleSubmit}
                disabled={
                  !isConnected || (!input.trim() && !hasDrawing && attachedImages.length === 0)
                }
              >
                {t('commandPalette.send')}
              </button>
            </div>
          </div>
          {activeStatus && (
            <div className={statusClass(activeStatus.status)}>{statusLabel(activeStatus)}</div>
          )}
          {/* Fixed slot for the window tabs — a phone's are in the shade instead, and
            an empty slot there would only be 31px of the palette's own height. */}
          {!isMobile && (
            <div className={styles.taskbarSlot}>
              <Taskbar />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
