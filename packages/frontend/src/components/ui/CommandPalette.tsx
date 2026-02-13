/**
 * CommandPalette - Input for sending messages to the agent.
 */
import { useState, useCallback, useRef, useEffect, KeyboardEvent } from 'react';
import { useAgentConnection } from '@/hooks/useAgentConnection';
import { useDesktopStore } from '@/store';
import { DebugPanel } from './DebugPanel';
import { RecentActionsPanel } from './RecentActionsPanel';
import { SessionsModal } from './SessionsModal';
import { SettingsModal } from './SettingsModal';
import { Taskbar } from './Taskbar';
import styles from '@/styles/ui/CommandPalette.module.css';

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
  const [input, setInput] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  const { isConnected, sendMessage, interrupt, reset } = useAgentConnection();
  const debugPanelOpen = useDesktopStore((state) => state.debugPanelOpen);
  const toggleDebugPanel = useDesktopStore((state) => state.toggleDebugPanel);
  const recentActionsPanelOpen = useDesktopStore((state) => state.recentActionsPanelOpen);
  const toggleRecentActionsPanel = useDesktopStore((state) => state.toggleRecentActionsPanel);
  const sessionsModalOpen = useDesktopStore((state) => state.sessionsModalOpen);
  const toggleSessionsModal = useDesktopStore((state) => state.toggleSessionsModal);
  const settingsModalOpen = useDesktopStore((state) => state.settingsModalOpen);
  const toggleSettingsModal = useDesktopStore((state) => state.toggleSettingsModal);
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

  // Close settings popover on outside click
  useEffect(() => {
    if (!settingsOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        settingsRef.current &&
        !settingsRef.current.contains(e.target as Node) &&
        gearRef.current &&
        !gearRef.current.contains(e.target as Node)
      ) {
        setSettingsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [settingsOpen]);

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
            message: agentCount === 1 ? 'Agent stopped' : `${agentCount} agents stopped`,
            variant: 'info',
          });
        }
      }
    },
    [handleSubmit, interrupt, activeAgents, applyAction],
  );

  const handleReset = useCallback(() => {
    reset();
    applyAction({
      type: 'toast.show',
      id: `reset-${Date.now()}`,
      message: 'Desktop and context reset',
      variant: 'info',
    });
  }, [reset, applyAction]);

  return (
    <>
      {debugPanelOpen && <DebugPanel />}
      {recentActionsPanelOpen && <RecentActionsPanel />}
      {sessionsModalOpen && <SessionsModal />}
      {settingsModalOpen && <SettingsModal />}
      <div className={styles.container} data-expanded={isExpanded}>
        {hasDrawing && (
          <div className={styles.drawingIndicator}>
            <span className={styles.drawingIcon}>&#9998;</span>
            <span>Drawing attached</span>
            <button
              className={styles.clearDrawingButton}
              onClick={clearDrawing}
              title="Clear drawing"
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
                  title="Remove image"
                >
                  &times;
                </button>
              </div>
            ))}
            {attachedImages.length > 1 && (
              <button className={styles.clearAllImages} onClick={clearAttachedImages}>
                Clear all
              </button>
            )}
          </div>
        )}
        <div className={styles.inputRow}>
          {/* Gear settings + Reset buttons */}
          <div className={styles.actionButtons}>
            <div className={styles.gearWrapper}>
              <button
                ref={gearRef}
                className={styles.gearButton}
                onClick={() => setSettingsOpen((v) => !v)}
                title="Settings"
                data-active={settingsOpen}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 20 20"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M10 12.5C11.3807 12.5 12.5 11.3807 12.5 10C12.5 8.61929 11.3807 7.5 10 7.5C8.61929 7.5 7.5 8.61929 7.5 10C7.5 11.3807 8.61929 12.5 10 12.5Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M16.1667 12.5C16.0557 12.7513 16.0226 13.0302 16.0716 13.3005C16.1206 13.5708 16.2495 13.8203 16.4417 14.0167L16.4917 14.0667C16.6466 14.2215 16.7695 14.4053 16.8534 14.6076C16.9373 14.8099 16.9805 15.0268 16.9805 15.2458C16.9805 15.4649 16.9373 15.6817 16.8534 15.8841C16.7695 16.0864 16.6466 16.2702 16.4917 16.425C16.3369 16.5799 16.1531 16.7028 15.9507 16.7867C15.7484 16.8706 15.5315 16.9138 15.3125 16.9138C15.0935 16.9138 14.8766 16.8706 14.6743 16.7867C14.472 16.7028 14.2881 16.5799 14.1333 16.425L14.0833 16.375C13.887 16.1828 13.6375 16.0539 13.3672 16.0049C13.0968 15.9559 12.818 15.989 12.5667 16.1C12.3203 16.2056 12.1124 16.3833 11.9694 16.6103C11.8264 16.8374 11.7546 17.1033 11.7633 17.3725V17.5C11.7633 17.942 11.5877 18.366 11.2752 18.6785C10.9626 18.9911 10.5387 19.1667 10.0967 19.1667C9.65468 19.1667 9.23076 18.9911 8.91819 18.6785C8.60563 18.366 8.43001 17.942 8.43001 17.5V17.425C8.43261 17.1484 8.35126 16.8776 8.19605 16.6503C8.04083 16.423 7.81928 16.2501 7.56001 16.1558C7.30869 16.0449 7.02985 16.0118 6.75951 16.0608C6.48917 16.1098 6.23967 16.2387 6.04334 16.4308L5.99334 16.4808C5.83851 16.6358 5.65473 16.7587 5.45238 16.8426C5.25004 16.9265 5.03317 16.9697 4.81417 16.9697C4.59518 16.9697 4.37831 16.9265 4.17597 16.8426C3.97362 16.7587 3.78984 16.6358 3.63501 16.4808C3.4801 16.326 3.35722 16.1422 3.2733 15.9399C3.18939 15.7375 3.14617 15.5206 3.14617 15.3017C3.14617 15.0827 3.18939 14.8658 3.2733 14.6634C3.35722 14.4611 3.4801 14.2773 3.63501 14.1225L3.68501 14.0725C3.87718 13.8762 4.00609 13.6267 4.05509 13.3563C4.10409 13.086 4.07097 12.8071 3.96001 12.5558C3.85437 12.3095 3.67675 12.1016 3.44972 11.9585C3.22269 11.8155 2.95674 11.7438 2.68751 11.7525H2.56001C2.11799 11.7525 1.69406 11.577 1.3815 11.2644C1.06894 10.9518 0.893311 10.5279 0.893311 10.0858C0.893311 9.64383 1.06894 9.2199 1.3815 8.90734C1.69406 8.59478 2.11799 8.41916 2.56001 8.41916H2.63501C2.91159 8.42176 3.18245 8.34041 3.40971 8.18519C3.63698 8.02997 3.80991 7.80842 3.90418 7.54916C4.01513 7.29784 4.04826 7.019 3.99926 6.74866C3.95026 6.47832 3.82135 6.22882 3.62918 6.03249L3.57918 5.98249C3.42427 5.82766 3.30139 5.64388 3.21747 5.44153C3.13355 5.23919 3.09034 5.02232 3.09034 4.80332C3.09034 4.58433 3.13355 4.36746 3.21747 4.16512C3.30139 3.96277 3.42427 3.77899 3.57918 3.62416C3.73401 3.46925 3.91779 3.34637 4.12013 3.26245C4.32248 3.17853 4.53935 3.13532 4.75834 3.13532C4.97734 3.13532 5.19421 3.17853 5.39655 3.26245C5.5989 3.34637 5.78267 3.46925 5.93751 3.62416L5.98751 3.67416C6.18384 3.86633 6.43334 3.99524 6.70368 4.04424C6.97401 4.09324 7.25286 4.06012 7.50418 3.94916H7.56001C7.80634 3.84352 8.01427 3.6659 8.15728 3.43887C8.3003 3.21184 8.37203 2.94589 8.36334 2.67666V2.49999C8.36334 2.05797 8.53896 1.63404 8.85153 1.32148C9.16409 1.00892 9.58802 0.833293 10.03 0.833293C10.472 0.833293 10.896 1.00892 11.2085 1.32148C11.5211 1.63404 11.6967 2.05797 11.6967 2.49999V2.57499C11.688 2.84422 11.7597 3.11017 11.9028 3.3372C12.0458 3.56423 12.2537 3.74185 12.5 3.84749C12.7513 3.95845 13.0302 3.99158 13.3005 3.94258C13.5709 3.89358 13.8204 3.76467 14.0167 3.57249L14.0667 3.52249C14.2215 3.36758 14.4053 3.2447 14.6077 3.16079C14.81 3.07687 15.0269 3.03366 15.2459 3.03366C15.4649 3.03366 15.6817 3.07687 15.8841 3.16079C16.0864 3.2447 16.2702 3.36758 16.425 3.52249C16.5799 3.67732 16.7028 3.86109 16.7867 4.06344C16.8706 4.26579 16.9138 4.48266 16.9138 4.70166C16.9138 4.92065 16.8706 5.13752 16.7867 5.33987C16.7028 5.54221 16.5799 5.72599 16.425 5.88082L16.375 5.93082C16.1828 6.12716 16.0539 6.37666 16.0049 6.64699C15.9559 6.91733 15.989 7.19617 16.1 7.44749V7.49999C16.2056 7.74633 16.3833 7.95425 16.6103 8.09727C16.8373 8.24029 17.1033 8.31202 17.3725 8.30332H17.5C17.942 8.30332 18.366 8.47895 18.6785 8.79151C18.9911 9.10407 19.1667 9.528 19.1667 9.96999C19.1667 10.412 18.9911 10.8359 18.6785 11.1485C18.366 11.4611 17.942 11.6367 17.5 11.6367H17.425C17.1558 11.6454 16.8898 11.7171 16.6628 11.8601C16.4358 12.0031 16.2581 12.2111 16.1525 12.4574L16.1667 12.5Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {/* Settings popover */}
              {settingsOpen && (
                <div ref={settingsRef} className={styles.settingsPopover}>
                  <button
                    className={styles.settingsItem}
                    onClick={() => {
                      toggleSettingsModal();
                      setSettingsOpen(false);
                    }}
                    data-active={settingsModalOpen}
                  >
                    Settings
                  </button>
                  <button
                    className={styles.settingsItem}
                    onClick={() => {
                      toggleSessionsModal();
                      setSettingsOpen(false);
                    }}
                    data-active={sessionsModalOpen}
                  >
                    Sessions
                  </button>
                  <button
                    className={styles.settingsItem}
                    onClick={() => {
                      toggleRecentActionsPanel();
                      setSettingsOpen(false);
                    }}
                    data-active={recentActionsPanelOpen}
                  >
                    Actions
                  </button>
                  <div className={styles.settingsDivider} />
                  <button
                    className={styles.settingsItem}
                    onClick={() => {
                      toggleDebugPanel();
                      setSettingsOpen(false);
                    }}
                    data-active={debugPanelOpen}
                  >
                    Debug
                  </button>
                </div>
              )}
            </div>
            <button
              className={styles.resetButton}
              onClick={handleReset}
              title="Reset windows and context"
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
              className={styles.pencilButton}
              onClick={togglePencilMode}
              title={pencilMode ? 'Exit drawing (Esc)' : 'Draw on screen (Ctrl Ctrl)'}
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
                  ? 'Connecting...'
                  : isExpanded
                    ? 'Enter to send, Shift+Enter for new line, Esc to cancel'
                    : 'Ask the agent anything...'
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
              Send
            </button>
          </div>
        </div>
        {/* Fixed slot for minimized window tabs */}
        <div className={styles.taskbarSlot}>
          <Taskbar />
        </div>
      </div>
    </>
  );
}
