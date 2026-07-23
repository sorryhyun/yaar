// Automation surface for CDP-driven checks: run the pipeline and read structured
// results without clicking anything. Kept separate from the protocol because this
// is for *verifying the numerics* (raw scores, channel order A/B) rather than for
// an agent using the app.
import { capabilities, preprocess, decodeCtc, type ChannelOrder } from './model';
import { loadDataUrl } from './image-input';
import { loadSample, sampleLineRect, SAMPLE_LINES } from './sample';
import { runRecognition } from './recognize';
import { results, selection, setSelection, imageSize, setModelId, modelId } from './state';

export function installHeadlessHook(): void {
  (window as unknown as { __ocr: unknown }).__ocr = {
    ready: true,
    capabilities,
    loadSample,
    loadDataUrl,
    sampleLineRect,
    sampleLines: SAMPLE_LINES,
    setModel: (id: string) => setModelId(id),
    model: () => modelId(),
    setSelection,
    selection,
    imageSize,
    results: () => results().map((r) => ({ ...r, charScores: undefined })),
    /** ({rect?, order?}) => the full record, including per-character scores. */
    recognize: (options: Parameters<typeof runRecognition>[0] = {}) => runRecognition(options),
    // Exposed so the BGR-vs-RGB choice can be re-measured on identical pixels
    // instead of taken on faith. (Last measured: no difference, even on strongly
    // coloured text — see the note in model.ts.)
    preprocess,
    decodeCtc,
    /** Read every sample line in one call — the end-to-end smoke test. */
    readSample: async (order?: ChannelOrder) => {
      loadSample();
      const out: { expected: string; text: string; confidence: number }[] = [];
      for (let i = 0; i < SAMPLE_LINES.length; i++) {
        const record = await runRecognition({ rect: sampleLineRect(i), order });
        out.push({
          expected: SAMPLE_LINES[i],
          text: record.text,
          confidence: record.confidence,
        });
      }
      return out;
    },
  };
}
