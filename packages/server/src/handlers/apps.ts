/**
 * Apps domain handlers — compatibility barrel over `handlers/apps/`.
 *
 * Existing callers import `./apps.js` (`handlers/index.ts`) or `../../handlers/apps.js`
 * (`mcp/app-agent`, tests) and keep working unchanged. See `handlers/apps/index.ts` for
 * the domain overview and the module layout.
 */

export { registerAppsHandlers, appStoragePath, scopedAppStoragePath } from './apps/index.js';
