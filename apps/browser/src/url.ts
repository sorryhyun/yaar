/**
 * Reading what the user typed into the address bar.
 *
 * The bar takes two kinds of input, and they are handled by different halves of the
 * app: an address is navigated locally, and anything else is a request only the agent
 * can act on. Telling them apart is therefore not cosmetic — a phrase read as an
 * address navigates to a host that does not exist, and an address read as a phrase
 * spends a whole agent turn re-issuing a page load the app already did.
 */

/** Schemes the remote browser will navigate to when one is written out in full. */
const EXPLICIT_SCHEME = /^(?:https?|about|file):/i;

/**
 * Host, optional port, and whatever ends it — `/`, `?`, `#`, or the end of the string.
 * Anchored, so a match means the text *starts* as a hostname rather than merely
 * containing something host-shaped somewhere in the middle of a sentence.
 */
const HOST = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::\d+)?(?:[/?#]|$)/i;

/** A trailing label of two or more letters: the `com` of `example.com`. */
const TLD = /\.[a-z]{2,}$/i;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Hosts that are addresses despite having no dot at all. */
const DOTLESS_HOSTS = new Set(['localhost']);

function isHostLike(host: string): boolean {
  const name = host.toLowerCase();
  return DOTLESS_HOSTS.has(name) || IPV4.test(name) || TLD.test(name);
}

function isParseable(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * The address `text` names, or null when it names none.
 *
 * Null is the load-bearing answer: it means the input was a phrase, and a phrase is
 * what the agent gets. A returned string is the input plus a scheme where one was
 * missing and nothing else — no trailing slash, no re-serialization — so the bar goes
 * on showing what the user typed.
 */
export function parseAddress(text: string): string | null {
  const trimmed = text.trim();
  // Whitespace is the one unambiguous signal: no address carries it unescaped, and
  // nearly every phrase does.
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (EXPLICIT_SCHEME.test(trimmed)) return isParseable(trimmed) ? trimmed : null;

  const host = HOST.exec(trimmed)?.[1];
  if (!host || !isHostLike(host)) return null;
  const url = `https://${trimmed}`;
  return isParseable(url) ? url : null;
}

/**
 * `raw` as an http(s) URL, or null.
 *
 * Stricter than `parseAddress` on purpose: this reads a URL handed over by another
 * program (the `?url=` launch parameter), where a `file:` or `javascript:` value is
 * something to refuse rather than a typo to repair.
 */
export function parseHttpUrl(raw: string): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
