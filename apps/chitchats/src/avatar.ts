/**
 * Profile pictures — reading an image from anywhere, squaring it, and hanging it on a
 * character.
 *
 * Everything here is about getting arbitrary bytes into one shape: a centre-cropped
 * 256×256 PNG, stored as base64 in this app's own storage. The crop is not cosmetic.
 * An avatar is rendered at 24px beside every line of a transcript, so a 4MB photo would
 * be re-decoded on every repaint and would sit in `appDb`-adjacent storage forever; the
 * canvas pass turns any input into a predictable ~30-80KB file, which is what keeps a
 * cast of twenty characters cheap.
 *
 * Three sources, one path through: an uploaded `File`, a `data:` URL handed over by an
 * agent, or a path to an image that already exists in storage (typically something the
 * Anima app generated under `media/`). All three become a data URL first, because that
 * is the only input `<img>` can load without tainting the canvas it is drawn into.
 *
 * This module sits above the store (it calls `saveAvatar`) and below the UI, so nothing
 * here reaches back into a view.
 */

import { appStorage, storage } from '@bundled/yaar';

import { characterOf, saveAvatar } from './store';

/** The side length every avatar is cropped and scaled to. */
export const AVATAR_SIZE = 256;

/** `yaar://apps/{self|chitchats}/storage/…` — a path into this app's own storage. */
const OWN_STORAGE = /^yaar:\/\/apps\/(?:self|chitchats)\/storage\//;
/** `yaar://storage/…` — a path into the shared tree, where other apps publish. */
const SHARED_STORAGE = /^yaar:\/\/storage\//;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('that file is not an image this app can read'));
    img.src = src;
  });
}

/** Read a `File` or `Blob` as a data URL — the one input a canvas can take untainted. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('could not read that file'));
    reader.readAsDataURL(blob);
  });
}

/** Read an image out of this app's own storage as a data URL. */
async function ownStorageDataUrl(path: string): Promise<string> {
  const { data, mimeType, encoding } = await appStorage.readBinary(path);
  if (encoding !== 'base64') throw new Error(`${path} is not an image`);
  return `data:${mimeType};base64,${data}`;
}

/** Read an image out of the shared storage tree (`media/…`) as a data URL. */
async function sharedStorageDataUrl(path: string): Promise<string> {
  const blob = await storage.read(path, { as: 'blob' });
  if (!(blob instanceof Blob)) throw new Error(`${path} did not come back as a file`);
  return blobToDataUrl(blob);
}

/**
 * Turn any storage path into a data URL.
 *
 * A bare path is ambiguous — `media/anima/dragon.png` lives in the shared tree,
 * `characters/mara/avatar.png` in this app's own — so an unprefixed path is tried
 * against the shared tree first and falls back to app storage. A `yaar://`-prefixed one
 * says which tree it means and is not guessed at.
 */
export async function readImageAsDataUrl(imagePath: string): Promise<string> {
  const path = imagePath.trim();
  if (!path) throw new Error('Give a path to an image');
  if (path.startsWith('data:')) return path;

  if (OWN_STORAGE.test(path)) return ownStorageDataUrl(path.replace(OWN_STORAGE, ''));
  if (SHARED_STORAGE.test(path)) return sharedStorageDataUrl(path.replace(SHARED_STORAGE, ''));

  try {
    return await sharedStorageDataUrl(path);
  } catch {
    return ownStorageDataUrl(path);
  }
}

/**
 * Centre-crop and scale an image to a square PNG, returned as bare base64.
 *
 * The short side is what the crop is measured off, so a landscape photo loses its edges
 * rather than being squashed — a face stays a face at 24px.
 */
export async function squareImage(dataUrl: string, size = AVATAR_SIZE): Promise<string> {
  const img = await loadImage(dataUrl);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) throw new Error('that image has no dimensions');

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('this browser would not give the app a canvas');

  const side = Math.min(width, height);
  ctx.drawImage(img, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);

  const out = canvas.toDataURL('image/png');
  return out.slice(out.indexOf(',') + 1);
}

export interface AvatarSource {
  /** A path in storage — shared (`media/…`) or this app's own. */
  imagePath?: string;
  /** A `data:image/…;base64,…` URL, as an agent or a file picker produces. */
  dataUrl?: string;
}

/**
 * Give a character a profile picture from either kind of source.
 *
 * Always copies: the picture is squared and written into this app's own storage rather
 * than referenced where it lies, because the shared media tree is a staging area the
 * user may prune, and a cast card pointing at a deleted file is a broken image with no
 * way back.
 *
 * Returns the stored path.
 */
export async function setAvatarFrom(characterId: string, source: AvatarSource): Promise<string> {
  if (!characterOf(characterId)) throw new Error(`No character "${characterId}"`);

  const raw = source.dataUrl?.trim() || source.imagePath?.trim();
  if (!raw) throw new Error('Give either imagePath or dataUrl');

  const dataUrl = source.dataUrl?.trim()
    ? source.dataUrl.trim()
    : await readImageAsDataUrl(source.imagePath!);
  const base64 = await squareImage(dataUrl);
  return saveAvatar(characterId, base64, 'image/png');
}
