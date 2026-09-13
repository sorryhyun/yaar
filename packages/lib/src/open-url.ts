/**
 * Open a URL in the user's default browser (cross-platform).
 */

import { platform } from 'os';

export function openUrl(url: string): void {
  const p = platform();
  if (p === 'win32') {
    // rundll32 rather than `cmd /c start`, which treats & as a command separator
    // and so truncates any URL with query parameters.
    Bun.spawn(['rundll32', 'url.dll,FileProtocolHandler', url], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } else if (p === 'darwin') {
    Bun.spawn(['open', url], { stdio: ['ignore', 'ignore', 'ignore'] });
  } else {
    Bun.spawn(['xdg-open', url], { stdio: ['ignore', 'ignore', 'ignore'] });
  }
}
