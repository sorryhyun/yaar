/**
 * Legacy MCP tool registrations.
 *
 * @deprecated These individual MCP tools are superseded by verb mode (5 generic URI-based verbs).
 * Legacy tool mode will be removed in a future release.
 */

/** @deprecated Use verb mode instead. */
export { registerConfigNamespace, CONFIG_TOOL_NAMES } from './config/index.js';
/** @deprecated Use verb mode instead. */
export { registerWindowTools, WINDOW_TOOL_NAMES } from './window/index.js';
/** @deprecated Use verb mode instead. */
export { registerAppsTools, APPS_TOOL_NAMES } from './apps/index.js';
/** @deprecated Use verb mode instead. */
export { registerAppDevTools, DEV_TOOL_NAMES } from './dev/index.js';
/** @deprecated Use verb mode instead. */
export { registerBasicTools, BASIC_TOOL_NAMES } from './basic/index.js';
/** @deprecated Use verb mode instead. */
export { registerUserTools, USER_TOOL_NAMES } from './user/index.js';
/** @deprecated Use verb mode instead. */
export { registerBrowserTools, BROWSER_TOOL_NAMES, isBrowserAvailable } from './browser/index.js';
