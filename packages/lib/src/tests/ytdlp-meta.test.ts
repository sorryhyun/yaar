/**
 * `parseDownloadMeta` — the pre-download `--print` line `downloadAudio` reads the delivered
 * format and video metadata from. Pinned without spawning yt-dlp.
 */
import { describe, expect, it } from 'bun:test';
import { FORMAT_ID_RE, parseDownloadMeta } from '../ytdlp/ytdlp.js';

describe('parseDownloadMeta', () => {
  it('reads the selected format and the video metadata', () => {
    expect(
      parseDownloadMeta('140|m4a|mp4a.40.2|129.796|309288|jNQXAC9IVRw|19|Me at the zoo'),
    ).toEqual({
      id: 'jNQXAC9IVRw',
      title: 'Me at the zoo',
      durationSec: 19,
      format: {
        formatId: '140',
        ext: 'm4a',
        acodec: 'mp4a.40.2',
        abrKbps: 129.796,
        filesizeBytes: 309288,
      },
    });
  });

  it("keeps a '|' inside the title", () => {
    expect(parseDownloadMeta('251|webm|opus|106|252182|abc|19|A | B | C').title).toBe('A | B | C');
  });

  it('maps yt-dlp NA fields to empty strings and nulls', () => {
    const meta = parseDownloadMeta('251|webm|opus|NA|NA|abc|NA|T');
    expect(meta.durationSec).toBeNull();
    expect(meta.format.abrKbps).toBeNull();
    expect(meta.format.filesizeBytes).toBeNull();
    expect(parseDownloadMeta('NA|NA|NA|NA|NA|abc|1|T').format.formatId).toBe('');
  });
});

describe('FORMAT_ID_RE', () => {
  it('accepts format ids and refuses selectors', () => {
    for (const ok of ['140', '251-drc', 'hls-128']) expect(FORMAT_ID_RE.test(ok)).toBe(true);
    for (const bad of ['bestaudio/140', '140+251', '140[ext=m4a]', '', 'a b']) {
      expect(FORMAT_ID_RE.test(bad)).toBe(false);
    }
  });
});
