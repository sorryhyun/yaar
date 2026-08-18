import { getCanvas, getCtx, setRemoteSize, markFramePainted } from './context';
import { recordFrame } from './stats';

/** The JSON header every binary frame carries. `dropped` is a server-side running total. */
interface FrameHeader {
  w: number;
  h: number;
  dropped: number;
}

/**
 * Decode and paint one frame.
 *
 * Wire format is `[uint32 LE headerLen][JSON header][JPEG]` — see
 * `packages/server/src/websocket/screencast-handlers.ts`.
 */
export async function paintFrame(buf: ArrayBuffer): Promise<void> {
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);
  if (headerLen === 0 || headerLen + 4 > buf.byteLength) return;

  let header: FrameHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)));
  } catch {
    return;
  }

  const jpeg = new Uint8Array(buf, 4 + headerLen);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
  } catch {
    return;
  }

  const canvas = getCanvas();
  const ctx = getCtx();
  if (!canvas || !ctx) {
    bitmap.close();
    return;
  }

  setRemoteSize(header.w, header.h);
  // The canvas backing store is the *frame's* size, not the remote viewport's:
  // Chrome may scale a frame down, and stretching it back up here would be a
  // second resample on top of the JPEG's.
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  // A real frame outranks any still capture a tab switch has in flight (seed.ts).
  markFramePainted();

  recordFrame(buf.byteLength, header.dropped);
}
