/**
 * The native window's `window.yaarHost`, when there is one.
 *
 * YAAR's own desktop window (the macOS WKWebView today, later WebView2 and an Android APK)
 * injects a `YaarHost` into the **main frame** and nowhere else; Chrome, Cromite and dev have
 * none. Every call site keeps its browser path (`<a download>`, `navigator.clipboard`) as the
 * fallback, so `getHost()` returning null must mean "behave exactly as before".
 *
 * App iframes never see the host — the shell reports it to them (`yaar.device.get().host`)
 * and does the call on their behalf. Contract: `@yaar/shared`'s `host-contract.ts`.
 */
import { HOST_DOWNLOAD_MAX_BYTES, YAAR_HOST_VERSION } from '@yaar/shared';
import type { ToastShowAction, YaarHost, YaarHostCap, YaarHostFile } from '@yaar/shared';

declare global {
  interface Window {
    yaarHost?: YaarHost;
  }
}

/** The host, or null when there is none or it speaks a contract version this build does not. */
export function getHost(): YaarHost | null {
  const host = (globalThis as { window?: Window }).window?.yaarHost;
  if (!host || typeof host !== 'object') return null;
  return (host as { version?: unknown }).version === YAAR_HOST_VERSION ? host : null;
}

/** The host, only if it advertises `cap` — the check to make before an optional member. */
export function hostWith(cap: YaarHostCap): YaarHost | null {
  const host = getHost();
  return host && Array.isArray(host.caps) && host.caps.includes(cap) ? host : null;
}

export function hostCan(cap: YaarHostCap): boolean {
  return hostWith(cap) !== null;
}

/** What the shell tells an app frame about the host — never the host itself. */
export function hostSummary(): { platform: string; caps: string[] } | null {
  const host = getHost();
  return host ? { platform: host.platform, caps: [...host.caps] } : null;
}

export type HostSaveResult = { ok: true; savedTo: string } | { ok: false; error: string };

/** Save a file through the host's `download`. Never throws. */
export async function saveViaHost(host: YaarHost, file: YaarHostFile): Promise<HostSaveResult> {
  if (file.bytes.byteLength > HOST_DOWNLOAD_MAX_BYTES) {
    const mb = Math.round(HOST_DOWNLOAD_MAX_BYTES / (1024 * 1024));
    return { ok: false, error: `too large to save from here (over ${mb} MB)` };
  }
  try {
    const { savedTo } = await host.download(file);
    return { ok: true, savedTo };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The toast that reports a host save, the way the shell reports other local outcomes. */
export function hostSaveToast(name: string, result: HostSaveResult): ToastShowAction {
  const id = `host-save-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return result.ok
    ? { type: 'toast.show', id, message: `Saved to ${result.savedTo}`, variant: 'success' }
    : {
        type: 'toast.show',
        id,
        message: `Couldn't save ${name}: ${result.error}`,
        variant: 'error',
        duration: 8000,
      };
}
