// The two icon buttons overlaying the canvas: copy the PNG to the clipboard, or
// download it. Both read pixels straight off the canvas.
import { errMsg } from '@bundled/yaar';
import { bucket, canvas, hasImage, seed, setStatus } from '../state';
import { canvasBlob } from '../utils/canvas';

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
