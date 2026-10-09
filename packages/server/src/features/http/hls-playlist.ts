/**
 * HLS playlist rewriting for the streaming proxy.
 *
 * A playlist names its variants, segments, keys and init sections by URI, usually
 * relative ones. Served through `/api/media-proxy?url=…`, a relative `seg-1.ts` resolves
 * against `/api/` and the player fetches nothing; an absolute one goes around the proxy
 * and loses the `Referer` a gated CDN wants. So the proxy reads a playlist whole and
 * rewrites every URI in it to another proxy URL — the player then never leaves YAAR's
 * origin, and each hop gets the same SSRF check and domain gate as the first.
 */

const PLAYLIST_TYPE = /^\s*(application|audio)\/(vnd\.apple\.|x-)?mpegurl\b/i;
const PLAYLIST_PATH = /\.m3u8?$/i;

/** Whether an upstream response is (or claims to be) an HLS playlist worth reading whole. */
export function looksLikePlaylist(contentType: string | null, url: string): boolean {
  if (contentType && PLAYLIST_TYPE.test(contentType)) return true;
  try {
    return PLAYLIST_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Whether `text` is an HLS playlist — every one starts with `#EXTM3U` (RFC 8216 §4.3.1.1). */
export function isPlaylistText(text: string): boolean {
  return /^(\uFEFF)?\s*#EXTM3U/.test(text);
}

/**
 * Rewrite every URI in `text`: URI lines, and the `URI="…"` attribute of any tag
 * (`EXT-X-KEY`, `EXT-X-MAP`, `EXT-X-MEDIA`, `EXT-X-I-FRAME-STREAM-INF`, `EXT-X-PART`, …).
 * Each is resolved against `base` (the playlist's own final URL) and handed to `proxy`;
 * a URI that is not http(s) once resolved (`data:`, `skd:` key systems) is left as is.
 */
export function rewritePlaylist(
  text: string,
  base: string,
  proxy: (url: string) => string,
): string {
  const map = (uri: string): string => {
    let abs: URL;
    try {
      abs = new URL(uri, base);
    } catch {
      return uri;
    }
    return abs.protocol === 'http:' || abs.protocol === 'https:' ? proxy(abs.href) : uri;
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return t.startsWith('#EXT')
          ? line.replace(/URI="([^"]*)"/g, (_, u) => `URI="${map(u)}"`)
          : line;
      }
      return map(t);
    })
    .join('\n');
}
