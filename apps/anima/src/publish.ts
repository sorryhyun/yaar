/**
 * Publishing a generation to the shared media tree.
 *
 * Anima's own gallery stays where it is — `yaar://apps/anima/storage/generated/` is
 * private to this app, and nothing else can read it. Publishing copies one image into
 * `yaar://storage/media/anima/`, the shared tree every app can be granted, so a
 * project being built in devtools can pick it up as a build-time asset.
 *
 * The copy happens server-side (`action: 'copy'`). The alternative — handing the image
 * out as a data URL for someone else to write — routes ~550KB of base64 through
 * whatever asked for it, which for an agent means through a model context.
 */

import { invoke } from '@bundled/yaar';
import { appStorageUri, listSavedImages, type SavedImage } from './appfiles';

/** Where published images land. One directory per producing app. */
const MEDIA_DIR = 'media/anima';

export function mediaUri(name: string): string {
  return `yaar://storage/${MEDIA_DIR}/${name}`;
}

/**
 * Resolve which saved image to publish.
 *
 * `undefined` means "the most recent one", which is what "publish that" means when
 * the user has just watched an image appear.
 */
export async function resolveImage(pathOrName?: string): Promise<SavedImage> {
  const saved = await listSavedImages();
  if (saved.length === 0) throw new Error('No generated images to publish yet.');
  if (!pathOrName) return saved[0];

  const needle = pathOrName.replace(/^yaar:\/\/apps\/anima\/storage\//, '').replace(/^\/+/, '');
  const match = saved.find((s) => s.path === needle || s.name === needle);
  if (!match) {
    throw new Error(
      `No saved image matches "${pathOrName}". Known: ${saved
        .slice(0, 5)
        .map((s) => s.name)
        .join(', ')}`,
    );
  }
  return match;
}

export interface PublishResult {
  uri: string;
  name: string;
  source: string;
}

/** Copy one saved image into `media/anima/`. Returns the shared URI it now has. */
export async function publishImage(pathOrName?: string, asName?: string): Promise<PublishResult> {
  const image = await resolveImage(pathOrName);
  const name = (asName ?? image.name).replace(/^\/+/, '').replace(/\//g, '-');
  if (!name) throw new Error('Published name must not be empty.');

  await invoke(mediaUri(name), { action: 'copy', from: appStorageUri(image.path) });

  return { uri: mediaUri(name), name, source: image.path };
}
