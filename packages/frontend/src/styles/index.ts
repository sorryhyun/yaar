/**
 * Style exports - centralized CSS module imports.
 *
 * Components import styles from this directory using the path alias:
 * import styles from '@/styles/ComponentName.module.css'
 */

// Re-export individual style modules for type-safe imports
export { default as desktopSurfaceStyles } from './DesktopSurface.module.css'
export { default as commandPaletteStyles } from './CommandPalette.module.css'
export { default as debugPanelStyles } from './DebugPanel.module.css'
export { default as notificationCenterStyles } from './NotificationCenter.module.css'
export { default as toastContainerStyles } from './ToastContainer.module.css'
export { default as windowFrameStyles } from './WindowFrame.module.css'
export { default as renderersStyles } from './renderers.module.css'
