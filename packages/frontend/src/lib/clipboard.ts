/**
 * The clipboard leg of `yaar://user/clipboard` — the only code in YAAR that can touch it.
 *
 * The server asks (`user.clipboard.read` / `user.clipboard.write`) and this answers with a
 * `CLIPBOARD_RESPONSE` sent straight down the socket, the same shape as `capture.ts`:
 * bypassing the Zustand queue because a turn is parked on the answer.
 *
 * Two things this module is responsible for that the server cannot be:
 *
 * **Applying the ceilings before the data crosses the wire.** A 4K screenshot is ~30 MB
 * decoded and ~40 MB as base64. Sending it and trimming server-side would move it through
 * a WebSocket frame, a JSON parse and a string copy first — the read has to be small here
 * or it is not small anywhere. So `maxChars`/`maxImagePx`/`maxImageBytes` ride in on the
 * action and are applied at the source.
 *
 * **Naming the failure.** `navigator.clipboard` rejects with a `NotAllowedError` for two
 * completely different situations — the user has not granted clipboard access, and the tab
 * simply is not focused — and the fix for one is nothing like the fix for the other. The
 * agent downstream will act on whatever it is told, so the distinction is made here, where
 * the exception still exists, rather than guessed at three layers up.
 */
import {
  ClientEventType,
  type UserClipboardReadAction,
  type UserClipboardWriteAction,
} from '@/types';
import type { ClipboardImagePayload, ClipboardResponseEvent } from '@yaar/shared';
import { wsManager, sendEvent } from '@/hooks/use-agent-connection/transport-manager';

type ClipboardFailure = Pick<ClipboardResponseEvent, 'reason' | 'error'>;

/**
 * Turn a `navigator.clipboard` rejection into a reason the caller can act on.
 *
 * The focus case is matched on the message rather than the name because the platform gives
 * it the same `NotAllowedError` name as a denied permission. That string match is the only
 * signal there is; when it does not match, "denied" is the safer of the two to report —
 * it points at a permission the user can actually go and grant, whereas a wrong
 * "not focused" sends them to click a desktop that was focused all along.
 */
export function classifyClipboardError(err: unknown): ClipboardFailure {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);

  if (/not focused|document is not focused/i.test(message)) {
    return { reason: 'not-focused', error: message };
  }
  if (name === 'NotAllowedError' || /permission|denied/i.test(message)) {
    return { reason: 'denied', error: message };
  }
  if (name === 'NotFoundError') {
    return { reason: 'empty', error: message };
  }
  return { reason: 'failed', error: message };
}

/**
 * Trim to `maxChars`, never mid-character.
 *
 * A plain `slice` can cut a surrogate pair in half, which produces a lone surrogate: it
 * survives JSON, reaches the model as U+FFFD, and turns a truncation into a corruption at
 * exactly the boundary a reader would look at first. One emoji at the wrong offset is
 * enough. `totalChars` is UTF-16 code units — the same unit `maxChars` is in, so the two
 * numbers can be compared.
 */
export function truncateClipboardText(
  text: string,
  maxChars: number,
): { text: string; truncated?: true; totalChars?: number } {
  if (maxChars <= 0 || text.length <= maxChars) return { text };

  let cut = maxChars;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // leading half of a pair — drop it

  return { text: text.slice(0, cut), truncated: true, totalChars: text.length };
}

/** Base64 of a blob, without the `data:` prefix — the shape the server stores and forwards. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read clipboard image'));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Size a clipboard image to the request's ceilings, reporting what it *was*.
 *
 * `width`/`height` are always the natural size, even when what comes back is a thumbnail:
 * base64 alone cannot say whether it is a downscaled 4K screenshot or a small image that
 * arrived untouched, and those two mean different things to whoever reads it.
 *
 * `maxImagePx: 0` disables downscaling — that is the `save` path, where the bytes are
 * going to a file and full resolution is the whole point.
 */
async function encodeImage(
  blob: Blob,
  maxImagePx: number,
  maxImageBytes: number,
): Promise<ClipboardImagePayload | ClipboardFailure> {
  let bitmap: ImageBitmap | undefined;
  let width = 0;
  let height = 0;
  try {
    bitmap = await createImageBitmap(blob);
    width = bitmap.width;
    height = bitmap.height;

    let out = blob;
    let downscaled = false;
    const scale = maxImagePx > 0 ? Math.min(1, maxImagePx / Math.max(width, height)) : 1;

    if (scale < 1) {
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, w, h);
        const shrunk = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/webp', 0.85),
        );
        // Only take the re-encode if it actually helped. A tiny PNG re-encoded to WebP can
        // come out larger, and shipping the bigger one while calling it a downscale is a
        // lie in both directions.
        if (shrunk && shrunk.size < blob.size) {
          out = shrunk;
          downscaled = true;
        }
      }
    }

    if (out.size > maxImageBytes) {
      return {
        reason: 'too-large',
        error: `${width}×${height}, ${Math.round(out.size / 1024)} KB encoded, over the ${Math.round(
          maxImageBytes / 1024,
        )} KB ceiling`,
      };
    }

    return {
      data: await blobToBase64(out),
      mimeType: out.type || blob.type || 'image/png',
      bytes: out.size,
      width,
      height,
      ...(downscaled ? { downscaled: true } : {}),
    };
  } catch (err) {
    return classifyClipboardError(err);
  } finally {
    bitmap?.close?.();
  }
}

function isFailure(v: ClipboardImagePayload | ClipboardFailure): v is ClipboardFailure {
  return 'reason' in v;
}

/** Pull text and (optionally) an image off the clipboard, applying the request's ceilings. */
async function readClipboard(
  action: UserClipboardReadAction,
): Promise<Omit<ClipboardResponseEvent, 'type' | 'requestId'>> {
  if (!navigator.clipboard) {
    return { ok: false, reason: 'unsupported', error: 'navigator.clipboard is unavailable' };
  }
  // Chrome rejects an unfocused read with a NotAllowedError that reads like a permission
  // denial. Checking first turns "the user must grant clipboard access" — which they may
  // already have done — into "click the desktop", which is the actual fix.
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) {
    return {
      ok: false,
      reason: 'not-focused',
      error: 'The YAAR tab does not have focus, and browsers refuse clipboard reads to it.',
    };
  }

  let text: string | undefined;
  let imageBlob: Blob | undefined;

  if (action.image && typeof navigator.clipboard.read === 'function') {
    try {
      for (const item of await navigator.clipboard.read()) {
        const imageType = item.types.find((t) => t.startsWith('image/'));
        if (imageType && !imageBlob) imageBlob = await item.getType(imageType);
        if (item.types.includes('text/plain') && text === undefined) {
          text = await (await item.getType('text/plain')).text();
        }
      }
    } catch (err) {
      // `read()` is the richer API and the less widely implemented one. Falling back to
      // `readText()` means a browser without it still answers with the text rather than
      // reporting the whole clipboard unreadable.
      if (typeof navigator.clipboard.readText !== 'function') {
        return { ok: false, ...classifyClipboardError(err) };
      }
      try {
        text = await navigator.clipboard.readText();
      } catch (textErr) {
        return { ok: false, ...classifyClipboardError(textErr) };
      }
    }
  } else {
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      return { ok: false, ...classifyClipboardError(err) };
    }
  }

  let image: ClipboardImagePayload | undefined;
  if (imageBlob) {
    const encoded = await encodeImage(imageBlob, action.maxImagePx, action.maxImageBytes);
    // An image that cannot be carried is reported as such even when text came along with
    // it: silently returning the `text/plain` alternative of a pasted screenshot answers a
    // question about a picture with a filename.
    if (isFailure(encoded)) return { ok: false, ...encoded };
    image = encoded;
  }

  if (!text && !image) return { ok: false, reason: 'empty' };

  return {
    ok: true,
    ...(text ? truncateClipboardText(text, action.maxChars) : {}),
    ...(image ? { image } : {}),
  };
}

async function writeClipboard(
  action: UserClipboardWriteAction,
): Promise<Omit<ClipboardResponseEvent, 'type' | 'requestId'>> {
  if (!navigator.clipboard?.writeText) {
    return { ok: false, reason: 'unsupported', error: 'navigator.clipboard is unavailable' };
  }
  try {
    await navigator.clipboard.writeText(action.text);
    return { ok: true };
  } catch (err) {
    return { ok: false, ...classifyClipboardError(err) };
  }
}

/**
 * Run a clipboard action and answer the server. Never throws: a turn is parked on this
 * frame, and a rejected promise here would leave it to time out with no reason attached.
 */
export async function handleClipboardAction(
  action: UserClipboardReadAction | UserClipboardWriteAction,
): Promise<void> {
  let result: Omit<ClipboardResponseEvent, 'type' | 'requestId'>;
  try {
    result =
      action.type === 'user.clipboard.read'
        ? await readClipboard(action)
        : await writeClipboard(action);
  } catch (err) {
    result = { ok: false, ...classifyClipboardError(err) };
  }

  sendEvent(wsManager, {
    type: ClientEventType.CLIPBOARD_RESPONSE,
    requestId: action.id,
    ...result,
  });
}
