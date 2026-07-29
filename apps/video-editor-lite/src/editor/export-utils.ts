import {
  BlobSource,
  Mp4OutputFormat,
  UrlSource,
  WebMOutputFormat,
  type DiscardedTrack,
  type Input,
  type OutputFormat,
  type Source,
} from '@bundled/mediabunny';

export const MIN_TRIM_GAP = 0.01;

export function makeExportFilename(extension: string, prefix = 'trim'): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  return `${prefix}-${stamp}.${extension}`;
}

/** Strip the leading dot mediabunny reports on `fileExtension` ('.mp4' -> 'mp4'). */
export function extensionForFormat(format: OutputFormat): string {
  return format.fileExtension.replace(/^\./, '');
}

/**
 * Wrap whatever URL the `<video>` element is playing as a mediabunny source.
 *
 * A `blob:`/`data:` URL is already bytes in this process, so reading it costs
 * nothing and `BlobSource` can seek it directly. Anything else is a real URL,
 * where `UrlSource` pulls byte ranges on demand instead of buffering an entire
 * lecture recording into memory before the trim starts.
 */
export async function sourceForVideoUrl(url: string): Promise<Source> {
  if (url.startsWith('blob:') || url.startsWith('data:')) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Unable to read the loaded video (HTTP ${response.status}).`);
    }
    return new BlobSource(await response.blob());
  }
  return new UrlSource(url);
}

/**
 * Keep the source container whenever we can.
 *
 * Trimming into the same container lets mediabunny pass the encoded packets
 * straight through — no decode, no re-encode, no generation loss, and far
 * faster than real time. Switching containers would force a full transcode.
 */
export async function pickOutputFormat(input: Input): Promise<OutputFormat> {
  const mimeType = await input.getMimeType();
  return /webm|matroska/i.test(mimeType) ? new WebMOutputFormat() : new Mp4OutputFormat();
}

const DISCARD_REASONS: Record<DiscardedTrack['reason'], string> = {
  discarded_by_user: 'it was excluded',
  max_track_count_reached: 'the output had no room for it',
  max_track_count_of_type_reached: 'the output cannot hold that kind of track',
  unknown_source_codec: 'its codec could not be identified',
  undecodable_source_codec: 'this browser cannot decode its codec',
  no_encodable_target_codec: 'this browser cannot encode it into the output format',
};

/** Human-readable summary of tracks the conversion had to drop. */
export function describeDiscardedTracks(tracks: DiscardedTrack[]): string {
  return tracks
    .map((discarded) => {
      const kind = discarded.track.isVideoTrack()
        ? 'Video'
        : discarded.track.isAudioTrack()
          ? 'Audio'
          : 'Track';
      return `${kind} dropped because ${DISCARD_REASONS[discarded.reason]}`;
    })
    .join('; ');
}
