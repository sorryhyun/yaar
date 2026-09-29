/**
 * `yaar:download` — an app frame's `downloadBlob()` inside YAAR's own native window.
 *
 * The frame sits on the app origin and cannot reach `window.yaarHost` (main frame only), and
 * its own `<a download>` saves nothing in a WKWebView. The SDK learns the shell can save from
 * the device state (`host.caps` includes `download`) and transfers the bytes here; the shell
 * saves them through the host and reports where they landed.
 *
 * Trust: the message must come from an iframe inside a desktop window (the router resolves
 * `source`), the shell must itself have a host with `download`, and the payload is validated
 * and capped (`HOST_DOWNLOAD_MAX_BYTES`, enforced by `saveViaHost`). The file name is reduced
 * to a bare name here; the host still owns the destination, so a frame chooses nothing but
 * the name and the bytes.
 */
import { APP_MSG } from '@yaar/shared';
import { hostSaveToast, hostWith, saveViaHost } from '@/lib/host';
import { iframeMessages } from '@/lib/iframeMessageRouter';
import { getDesktopState } from './store-access';

/** A path-free file name: no separators or characters a filesystem rejects, never empty. */
function bareName(raw: string): string {
  const name = raw
    // eslint-disable-next-line no-control-regex -- control characters are what is stripped
    .replace(/[/\\?%*:|"<>\u0000-\u001f]/g, '-')
    .replace(/^\.+/, '')
    .trim();
  return name.slice(0, 200) || 'download';
}

export function initHostDownloadHandler() {
  iframeMessages.on(APP_MSG.download, (ctx) => {
    if (!ctx.source) return;
    const host = hostWith('download');
    if (!host) return;

    const { name, mime, bytes } = ctx.data ?? {};
    if (typeof name !== 'string' || !(bytes instanceof ArrayBuffer)) return;

    const fileName = bareName(name);
    void saveViaHost(host, {
      name: fileName,
      mime: typeof mime === 'string' && mime ? mime.slice(0, 200) : 'application/octet-stream',
      bytes,
    }).then((result) => getDesktopState().applyActions([hostSaveToast(fileName, result)]));
  });
}
