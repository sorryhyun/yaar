/**
 * CursorSpinner - Small spinner that follows the cursor when AI is thinking.
 */
import { useEffect, useState } from 'react';
import { useDesktopStore } from '@/store';
import styles from '@/styles/ui/CursorSpinner.module.css';

export function CursorSpinner() {
  const activeAgents = useDesktopStore((s) => s.activeAgents);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [visible, setVisible] = useState(false);

  const hasActiveAgents = Object.keys(activeAgents).length > 0;

  useEffect(() => {
    if (!hasActiveAgents) {
      setVisible(false);
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      setPosition({ x: e.clientX, y: e.clientY });
      setVisible(true);
    };

    const handleMouseLeave = () => {
      setVisible(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [hasActiveAgents]);

  if (!hasActiveAgents || !visible) {
    return null;
  }

  return (
    <div
      className={styles.spinner}
      style={{
        left: position.x + 16,
        top: position.y + 16,
      }}
    />
  );
}
