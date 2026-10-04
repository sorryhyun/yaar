import { defineAppCommand } from '@bundled/yaar';
import { analyzeAudioFile, compareReports, type AudioAnalysis } from '../services';

// Ears for an agent that has none. An app that makes sound gets checked by rendering it
// to a file and measuring the file; this is the measuring half, so the numbers come from
// one audited implementation (lib/audio-analysis.ts) instead of arithmetic re-typed into
// a previewEval on every iteration.

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function blocks(results: AudioAnalysis[], summary: unknown) {
  return [
    { type: 'text', text: JSON.stringify(summary, null, 1) },
    ...results.flatMap((r) =>
      r.image ? [{ type: 'image', data: r.image, mimeType: 'image/png' }] : [],
    ),
  ];
}

export const audioCommands = {
  analyzeAudio: defineAppCommand({
    description:
      'Measure an audio file (WAV, FLAC, MP3, OGG/Opus, M4A) and return numbers plus a ' +
      'picture, in place of listening: integrated / max short-term loudness (BS.1770 LUFS) ' +
      'and loudness range, sample peak, RMS, crest factor, clipped samples, DC offset, ' +
      "leading/trailing silence, stereo correlation and side-to-mid, each mixing band's " +
      'share of the energy in dB (sub 20-60 Hz, bass, lowMid, mid, upperMid, presence, ' +
      'brilliance 6k+), spectral centroid, a loudness/peak timeline, and a tempo estimate ' +
      '(half/double-time is how it is wrong). The image is a waveform over a log-frequency ' +
      'spectrogram. To check what a change did, render before and after and pass the ' +
      'second as `compareTo`: the answer leads with `delta` (B minus A). Measures what was ' +
      'rendered, not whether it sounds good — ask the user to listen for a judgment call.',
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
