// @ts-nocheck — This file runs in browser iframes, not the server.
/**
 * Gated SDK for @bundled/yaar-dev.
 *
 * Provides dev tools (compile, typecheck, deploy) as top-level exports.
 * Requires "yaar-dev" in app.json bundles field to import.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function devHeaders(): Record<string, string> {
  const t = (window as any).__YAAR_TOKEN__ || '';
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (t) h['X-Iframe-Token'] = t;
  return h;
}

async function devPost<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/dev/${action}`, {
    method: 'POST',
    headers: devHeaders(),
    body: JSON.stringify(body),
  });
  return res.json();
}

export function compile(path: string, opts?: { title?: string }) {
  return devPost<{ success: boolean; previewUrl?: string; errors?: string[] }>('compile', {
    path,
    ...opts,
  });
}

export function typecheck(path: string) {
  return devPost<{ success: boolean; diagnostics: string[] }>('typecheck', { path });
}

export function deploy(
  path: string,
  opts: {
    appId: string;
    name?: string;
    icon?: string;
    description?: string;
    permissions?: string[];
  },
) {
  return devPost<{
    success: boolean;
    appId?: string;
    name?: string;
    icon?: string;
    error?: string;
  }>('deploy', { path, ...opts });
}

export async function bundledLibraries(): Promise<string[]> {
  const res = await fetch('/api/dev/bundled-libraries', { headers: devHeaders() });
  return res.json();
}
