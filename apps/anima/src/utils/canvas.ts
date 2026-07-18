// Canvas readback helper shared by the pipeline (app-storage persistence) and the
// image action buttons (copy/save).
import { canvas } from '../state';

export function canvasBlob(): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const el = canvas();
    if (!el) return reject(new Error('canvas not mounted'));
    el.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      'image/png',
    );
  });
}
