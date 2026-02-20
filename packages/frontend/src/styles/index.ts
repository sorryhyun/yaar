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
export { default as componentsStyles } from './base/components.module.css';
export { default as formsStyles } from './base/forms.module.css';
export { default as layoutStyles } from './base/layout.module.css';
export { default as typographyStyles } from './base/typography.module.css';

// Desktop
export { default as desktopSurfaceStyles } from './desktop/DesktopSurface.module.css';

// Window
export { default as windowFrameStyles } from './window/WindowFrame.module.css';
export { default as renderersStyles } from './window/renderers.module.css';

// Command palette
export { default as commandPaletteStyles } from './command-palette/CommandPalette.module.css';

// Overlays
export { default as debugPanelStyles } from './overlays/DebugPanel.module.css';
export { default as notificationCenterStyles } from './overlays/NotificationCenter.module.css';
export { default as toastContainerStyles } from './overlays/ToastContainer.module.css';
