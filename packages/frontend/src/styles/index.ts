/**
 * Style exports - centralized CSS module imports.
 *
 * Components import styles using the path alias:
 * import styles from '@/styles/<group>/ComponentName.module.css'
 *
 * Global styles (tokens.css) are imported in index.html
 * Animations (@keyframes) are defined locally in each module for proper CSS Module scoping
 */

// Base design system
export { default as componentsStyles } from './base/components.module.css'
export { default as formsStyles } from './base/forms.module.css'
export { default as layoutStyles } from './base/layout.module.css'
export { default as typographyStyles } from './base/typography.module.css'

// Desktop
export { default as desktopSurfaceStyles } from './desktop/DesktopSurface.module.css'

// Windows
export { default as windowFrameStyles } from './windows/WindowFrame.module.css'
export { default as renderersStyles } from './windows/renderers.module.css'

// UI
export { default as commandPaletteStyles } from './ui/CommandPalette.module.css'
export { default as debugPanelStyles } from './ui/DebugPanel.module.css'
export { default as notificationCenterStyles } from './ui/NotificationCenter.module.css'
export { default as toastContainerStyles } from './ui/ToastContainer.module.css'
