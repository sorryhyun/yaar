/**
 * Seeding the canvas: one server-side still capture, painted as if it were a frame.
 *
 * Chrome's screencast emits only on repaint. Pointing the socket at another target
 * therefore sends nothing at all until something on that page moves, so a tab the
 * user switches *back* to — sitting still by definition — leaves the canvas showing
 * the last frame of the tab they left. That stale frame reads as the current page.
 *
 * A still capture is addressed by `browserId` over HTTP rather than by whatever the
 * socket happens to be attached to, so it is the right tab's pixels even before the
 * attach lands, and `fresh` makes the server re-capture instead of serving its last
 * one. The screencast takes over from here the moment the page does anything.
 */
import { getCanvas, getCtx, desiredTab, framePaintedAt } from './context';
import { screenshotUrl } from '../endpoints';

/** Paint the current pixels of `browserId` onto the live canvas. */
export async function seedCanvas(browserId: string): Promise<boolean> {
  const canvas = getCanvas();
  const ctx = getCtx();
  if (!canvas || !ctx) return false;

  const paintedBefore = framePaintedAt();
  const img = new Image();
  img.src = screenshotUrl(browserId, true);
  try {
    await img.decode();
  } catch {
    // A tab that closed mid-switch is the common case here, and the strip already
    // says so — not worth a console line of its own.
    return false;
  }
  if (!img.naturalWidth || !img.naturalHeight) return false;

  // Two ways this capture is already the wrong thing to paint: the user moved on to
  // another tab while it was in flight, or the screencast beat us to it with a real
  // frame, which is fresher than this by definition.
  if (desiredTab() !== browserId) return false;
  if (framePaintedAt() !== paintedBefore) return false;

  // The backing store belongs to the screencast: paint.ts sizes it to the frame and
  // input.ts maps clicks through the remote viewport that frame reported. A seed
  // fills whatever is there rather than resizing it — except before the first frame,
  // when there is nothing to preserve and the canvas is still the 300x150 default.
  // Sizing a canvas clears it, so only do it when the size is actually wrong.
  // The fallback (fallback.ts) seeds repeatedly while a stream is silent, and on
  // that path no real frame ever arrives to move paintedBefore off 0.
  if (
    paintedBefore === 0 &&
    (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight)
  ) {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return true;
}
