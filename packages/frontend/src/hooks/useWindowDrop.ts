/**
 * Hook for handling drag-over and drop events on a window frame.
 * Supports app icon drops, iframe text drags, and external image file drops.
 */
import { useCallback, useState } from 'react';
import { useDesktopStore, getIframeDragSource, consumeIframeDragSource } from '@/store';
import { getRawWindowId } from '@/store/helpers';
import { filterImageFiles, uploadImages, isExternalFileDrag } from '@/lib/uploadImage';

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
        const rawId = getRawWindowId(windowId);
        useDesktopStore
          .getState()
          .queueGestureMessage(
            `<ui:drag>app "${appId}" dragged onto window "${windowTitle}" (id: ${rawId})</ui:drag>`,
          );
        return;
      }

      // Iframe text drag -> drop onto this window
      const dragSource = consumeIframeDragSource();
      if (dragSource) {
        e.preventDefault();
        const store = useDesktopStore.getState();
        const sourceWin = store.windows[dragSource.windowId];
        const sourceTitle = sourceWin?.title ?? dragSource.windowId;
        const sourceRawId = getRawWindowId(dragSource.windowId);
        const targetRawId = getRawWindowId(windowId);
        store.queueGestureMessage(
          `<ui:select>\n  selected_text: "${dragSource.text.slice(0, 1000)}"\n  source: window "${sourceTitle}" (id: ${sourceRawId})\n</ui:select>\n<ui:drag>\n  target: window "${windowTitle}" (id: ${targetRawId})\n</ui:drag>`,
        );
        return;
      }

      // Image file drop (only external drags from file manager, not in-page img drags)
      if (isExternalFileDrag() && e.dataTransfer.files.length > 0) {
        const imageFiles = filterImageFiles(e.dataTransfer.files);
        if (imageFiles.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          const rawId = getRawWindowId(windowId);
          uploadImages(imageFiles).then((paths) => {
            if (paths.length > 0) {
              const imageLines = paths.map((p) => `  image: ${p}`).join('\n');
              useDesktopStore
                .getState()
                .queueGestureMessage(
                  `<ui:image_drop>\n${imageLines}\n  source: window "${windowTitle}" (id: ${rawId})\n</ui:image_drop>`,
                );
            }
          });
        }
      }
    },
    [windowId, windowTitle],
  );

  return { isDragOver, handleDragOver, handleDragEnter, handleDragLeave, handleDrop };
}
