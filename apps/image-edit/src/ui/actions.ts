import { errMsg, showConfirm, showPrompt } from '@bundled/yaar';
import type { Filters } from '../core/doc';
import type { ExportFormat } from '../core/render';
import {
  deleteStorageFile,
  dispatch,
  doc,
  downloadExport,
  publishToMedia,
  saveToStorage,
  setStatus,
  tool,
  type StorageFile,
  type Tool,
} from '../store';

/** Derived predicates shared by the toolbar, the sidebar and the canvas pane. */
export const hasDoc = () => doc() != null;
export const activeTool = (id: Tool) => tool() === id;

export async function doExport(format: ExportFormat) {
  try {
    await downloadExport(format);
  } catch (e) {
    setStatus(errMsg(e));
  }
}

export async function doSaveToStorage() {
  const d = doc();
  if (!d) return;
  const suggested = `${d.base.name.replace(/\.[^.]+$/, '')}-edited`;
  const name = await showPrompt('Save to storage as:', { initial: suggested });
  if (name == null) return;
  try {
    await saveToStorage('png', name);
  } catch (e) {
    setStatus(errMsg(e));
  }
}

/**
 * Save, then copy into `media/image-edit/` so other apps can use the result — the
 * gesture behind "publish the logo so devtools can use it".
 */
export async function doPublish() {
  const d = doc();
  if (!d) return;
  const suggested = `${d.base.name.replace(/\.[^.]+$/, '')}-edited`;
  const name = await showPrompt('Publish to shared media as:', { initial: suggested });
  if (name == null) return;
  try {
    const { name: published } = await publishToMedia('png', name);
    setStatus(`Published ${published} — other apps can now use it.`);
  } catch (e) {
    setStatus(errMsg(e));
  }
}

export async function removeFile(file: StorageFile) {
  if (!(await showConfirm(`Delete “${file.name}” from storage?`))) return;
  try {
    await deleteStorageFile(file.path);
  } catch (e) {
    setStatus(errMsg(e));
  }
}

export function setFilter(key: keyof Filters, value: number) {
  dispatch({ type: 'filter', values: { [key]: value } });
}

export function removeSelection() {
  dispatch({ type: 'removeSelection' });
  setStatus('Selection removed — export as PNG to keep the transparency.');
}

export function cropToSelection() {
  dispatch({ type: 'cropToSelection' });
  setStatus(
    'Cropped to selection — everything outside it is now transparent. Export as PNG to keep it.',
  );
}
