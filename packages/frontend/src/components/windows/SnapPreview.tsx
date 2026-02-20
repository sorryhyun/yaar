/**
 * SnapPreview — translucent overlay showing where a window will snap on drop.
 */
import { createPortal } from 'react-dom';
import type { WindowBounds } from '@yaar/shared';
import styles from '@/styles/windows/SnapPreview.module.css';

interface SnapPreviewProps {
  bounds: WindowBounds | null;
}

export function SnapPreview({ bounds }: SnapPreviewProps) {
  if (!bounds) return null;

  return createPortal(
    <div
      className={styles.preview}
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.w,
        height: bounds.h,
      }}
    />,
    document.body,
  );
}
