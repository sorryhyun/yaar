// The icon buttons overlaying the canvas: copy the PNG to the clipboard, download
// it, or publish it to the shared media tree. The first two read pixels straight off
// the canvas; publish works from the already-saved file, so it costs nothing to
// re-encode.
import { errMsg } from '@bundled/yaar';
import { bucket, canvas, hasImage, seed, setStatus } from '../state';
import { canvasBlob } from '../utils/canvas';
import { publishImage } from '../publish';

export async function copyImage(): Promise<void> {
  const canvasEl = canvas();
  if (!canvasEl || !hasImage()) return;
  try {
    const blob = await canvasBlob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    setStatus('📋 image copied to clipboard');
  } catch (e) {
    setStatus('❌ copy failed: ' + errMsg(e));
  }
}

/**
 * Publish the newest generation to `media/anima/`, where other apps can reach it.
 *
 * Deliberately the most recent saved image rather than the canvas: publishing copies
 * a file that already exists on disk, so the bytes never round-trip through here.
 */
export async function publishToMedia(): Promise<void> {
  if (!hasImage()) return;
  try {
    const { name } = await publishImage();
    setStatus(`🌍 published ${name} to shared media`);
  } catch (e) {
    setStatus('❌ publish failed: ' + errMsg(e));
  }
}

export function saveImage(): void {
  const canvasEl = canvas();
  if (!canvasEl || !hasImage()) return;
  const name = `anima-${bucket().id}-seed${seed()}.png`;
  const a = document.createElement('a');
  a.href = canvasEl.toDataURL('image/png');
  a.download = name;
  a.click();
  setStatus(`💾 saved ${name}`);
}
