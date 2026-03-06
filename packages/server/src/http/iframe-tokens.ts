/**
 * Iframe-scoped token management.
 *
 * Tokens are generated when creating iframe windows and injected into the iframe SDK.
 * The server uses these tokens to identify iframe-originated requests and restrict
 * them to PUBLIC_ENDPOINTS only.
 */

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface TokenEntry {
  windowId: string;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const tokens = new Map<string, TokenEntry>();

/**
 * Generate a short-lived token tied to a windowId.
 * The token is injected into the iframe SDK so requests can self-identify.
 */
export function generateIframeToken(windowId: string): string {
  const token = crypto.randomUUID();
  const timer = setTimeout(() => {
    tokens.delete(token);
  }, TOKEN_TTL_MS);
  tokens.set(token, { windowId, createdAt: Date.now(), timer });
  return token;
}

/**
 * Validate an iframe token.
 * Returns the associated windowId if valid, null if expired/invalid.
 */
export function validateIframeToken(token: string): string | null {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
    clearTimeout(entry.timer);
    tokens.delete(token);
    return null;
  }
  return entry.windowId;
}

/**
 * Revoke a token (e.g., when a window is closed).
 */
export function revokeIframeToken(token: string): void {
  const entry = tokens.get(token);
  if (entry) {
    clearTimeout(entry.timer);
    tokens.delete(token);
  }
}
