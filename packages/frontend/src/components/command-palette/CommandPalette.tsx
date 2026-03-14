/**
 * CommandPalette - Input for sending messages to the agent.
 */
import { useState, useCallback, useMemo, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgentConnection } from '@/hooks/useAgentConnection';
import { useDesktopStore } from '@/store';
import type { MessageStatus } from '@/store/types';
import { QrCodeModal } from '../overlays/QrCodeModal';
import { Taskbar } from '../taskbar/Taskbar';
import { apiFetch, isRemoteMode } from '@/lib/api';
import styles from '@/styles/command-palette/CommandPalette.module.css';

function readFilesAsDataUrls(files: File[]): Promise<string[]> {
  return Promise.all(
    files
      .filter((f) => f.type.startsWith('image/'))
      .map(
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

export function CommandPalette() {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const [qrCodeOpen, setQrCodeOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const { isConnected, sendMessage, interrupt, reset } = useAgentConnection();
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

  // Derive the most relevant active status to display
  const activeStatus = useMemo((): MessageStatus | null => {
    const entries = Object.values(messageStatuses);
    if (entries.length === 0) return null;
    // Prioritize queued over accepted over sent
    const queued = entries.find((e) => e.status === 'queued');
    if (queued) return queued;
    const accepted = entries.find((e) => e.status === 'accepted');
    if (accepted) return accepted;
    return null; // Don't show 'sent' — avoid flicker for fast responses
  }, [messageStatuses]);

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData.items;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) imageFiles.push(file);
        }
      }
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
      const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
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
    sendMessage(trimmed);
    setInput('');
  }, [
    input,
    isConnected,
    sendMessage,
    hasDrawing,
    attachedImages.length,
    pencilMode,
    setPencilMode,
  ]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
    [handleSubmit, interrupt, activeAgents, applyAction, t],
  );

  const handleReset = useCallback(() => {
    reset();
    applyAction({
      type: 'toast.show',
      id: `reset-${Date.now()}`,
      message: t('commandPalette.toast.contextReset'),
      variant: 'info',
    });
  }, [reset, applyAction, t]);

  return (
    <>
      {qrCodeOpen && <QrCodeModal onClose={() => setQrCodeOpen(false)} />}
      <div className={styles.container} data-expanded={isExpanded}>
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
        <div className={styles.inputRow}>
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
            <button
              className={styles.resetButton}
              onClick={handleReset}
              title={t('commandPalette.tooltip.reset')}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 20 20"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M1.66669 3.33334V8.33334H6.66669"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M3.51669 12.5C4.09225 14.1245 5.19153 15.5077 6.64804 16.4297C8.10455 17.3517 9.8327 17.7602 11.5504 17.5894C13.2682 17.4186 14.8764 16.6787 16.1113 15.4888C17.3463 14.2989 18.1348 12.7265 18.3593 11.0178C18.5838 9.30909 18.231 7.57261 17.357 6.09244C16.4831 4.61227 15.1384 3.47475 13.5359 2.85192C11.9335 2.22909 10.1668 2.15772 8.51986 2.64888C6.87291 3.14005 5.44223 4.16467 4.45003 5.56668L1.66669 8.33334"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
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
          </div>

          <div
            className={styles.inputWrapper}
            data-dragover={isDragOver}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <textarea
              className={styles.input}
              value={input}
              onChange={(e) => setInput(e.target.value)}
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
          <div
            className={
              activeStatus.status === 'queued'
                ? styles.messageStatusQueued
                : styles.messageStatusAccepted
            }
          >
            {activeStatus.status === 'queued'
              ? `Queued (position ${activeStatus.position})`
              : 'Accepted'}
          </div>
        )}
        {/* Fixed slot for minimized window tabs */}
        <div className={styles.taskbarSlot}>
          <Taskbar />
        </div>
      </div>
    </>
  );
}
