import { defineAppCommand } from '@bundled/yaar';
import { analyzeAudioFile, compareReports, type AudioAnalysis } from '../services';

// Ears for an agent that has none. An app that makes sound gets checked by rendering it
// to a file and measuring the file; this is the measuring half, so the numbers come from
// one audited implementation (lib/audio-analysis.ts) instead of arithmetic re-typed into
// a preview/eval on every iteration.

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function blocks(results: AudioAnalysis[], summary: unknown) {
  return [
    { type: 'text', text: JSON.stringify(summary, null, 1) },
    ...results.flatMap((r) =>
      r.image ? [{ type: 'image', data: r.image, mimeType: 'image/png' }] : [],
    ),
  ];
}

// Its own file, but the `inspect` group: a command's group comes from its key.
export const audioCommands = {
  'inspect/audio': defineAppCommand({
    description:
      'Measure an audio file (WAV, FLAC, MP3, OGG/Opus, M4A) in place of listening: loudness, ' +
      'peaks, band balance, silence, stereo image, a timeline, tempo, and a spectrogram image ' +
      '(metric list: the audio-apps topic). Pass `compareTo` for before/after; the answer ' +
      'leads with `delta` (B minus A). It measures what was rendered, not whether it sounds good.',
    params: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description:
            'A yaar:// storage URI (yaar://storage/shared/…; a file a preview saved to its ' +
            'own storage is yaar://apps/preview--{projectId}/storage/…), or a path in the ' +
            'active project (src/assets/kick.wav).',
        },
        compareTo: {
          type: 'string',
          description: 'A second file, same spellings. Both are measured over the same slice.',
        },
        startSec: { type: 'number', description: 'Measure from here (default 0).' },
        durationSec: {
          type: 'number',
          description: 'Measure this long (default: to the end, at most 600s).',
        },
        segments: {
          type: 'number',
          description: 'Timeline resolution: equal segments across the slice (default 16, max 64).',
        },
        image: {
          type: 'boolean',
          description: 'Return the spectrogram picture (default true). False for numbers only.',
        },
      },
      required: ['uri'],
    },
    run: async (p) => {
      const opts = {
        startSec: num(p.startSec),
        durationSec: num(p.durationSec),
        segments: num(p.segments),
        image: p.image !== false,
      };
      const a = await analyzeAudioFile(String(p.uri), opts);
      if (typeof p.compareTo !== 'string' || !p.compareTo) {
        return blocks([a], {
          uri: a.ref,
          ...(a.truncated ? { note: a.truncated } : {}),
          ...a.report,
        });
      }
      const b = await analyzeAudioFile(p.compareTo, opts);
      return blocks([a, b], {
        delta: compareReports(a.report, b.report),
        a: { uri: a.ref, ...a.report },
        b: { uri: b.ref, ...b.report },
      });
    },
  }),
};
