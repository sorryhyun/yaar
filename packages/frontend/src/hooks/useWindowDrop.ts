/**
 * Hook for handling drag-over and drop events on a window frame.
 * Supports app icon drops, iframe text drags, and external file drops.
 *
 * Text and file drops are handed to `iframe-bridge/drop.ts`, which gives them to the
 * window's app when it claimed them with `app.onDrop`, and to the agent otherwise.
 */
import { useCallback, useState } from 'react';
import {
  useDesktopStore,
  getIframeDragSource,
  consumeIframeDragSource,
  dropFilesOnWindow,
  dropTextOnWindow,
} from '@/store';
import { isExternalFileDrag } from '@/lib/uploadImage';

interface UseWindowDropOptions {
  windowId: string;
  windowTitle: string;
}

export function useWindowDrop({ windowId, windowTitle }: UseWindowDropOptions) {
  const [isDragOver, setIsDragOver] = useState(false);

  const isValidDrag = useCallback((e: React.DragEvent) => {
    return (
      e.dataTransfer.types.includes('application/x-yaar-app') ||
      getIframeDragSource() ||
      (e.dataTransfer.types.includes('Files') && isExternalFileDrag())
    );
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (isValidDrag(e)) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-yaar-app')
          ? 'link'
          : 'copy';
        setIsDragOver(true);
      }
    },
    [isValidDrag],
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (isValidDrag(e)) {
        e.preventDefault();
        setIsDragOver(true);
        useDesktopStore.getState().userFocusWindow(windowId);
      }
    },
    [windowId, isValidDrag],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only reset when the cursor actually leaves the frame, not when moving between children
    const frame = e.currentTarget as HTMLElement;
    const related = e.relatedTarget as Node | null;
    if (!related || !frame.contains(related)) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      setIsDragOver(false);

      // App icon drop
      const appId = e.dataTransfer.getData('application/x-yaar-app');
      if (appId) {
        e.preventDefault();
        useDesktopStore
          .getState()
          .queueGestureMessage(
            `<ui:drag>app "${appId}" dragged onto window "${windowTitle}" (id: ${windowId})</ui:drag>`,
          );
        return;
      }

      // Iframe text drag -> drop onto this window
      const dragSource = consumeIframeDragSource();
      if (dragSource) {
        e.preventDefault();
        dropTextOnWindow(windowId, dragSource.text, dragSource.windowId);
        return;
      }

      // File drop (only external drags from the file manager, not in-page img drags).
      // Stopped here so the desktop surface beneath does not take it as a drop on the
      // background, which is what a non-image file dropped on a window used to become.
      if (isExternalFileDrag() && e.dataTransfer.files.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        dropFilesOnWindow(windowId, Array.from(e.dataTransfer.files));
      }
    },
    [windowId, windowTitle],
  );

  return { isDragOver, handleDragOver, handleDragEnter, handleDragLeave, handleDrop };
}
