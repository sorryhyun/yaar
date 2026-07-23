// The CTC label table, read from the model's own config at runtime.
//
// PaddleOCR ships each recognizer's character dictionary inside its `inference.yml`,
// next to the weights. This module fetches that file through the same proxy and the
// same IndexedDB cache the weights use, so the dictionary arrives from — and stays
// pinned to — the model it belongs to. It used to be a generated 77 KB source file;
// that copy could drift from the model it described, and nothing in this repo needs to
// contain 18,708 characters of Unicode.
//
// **The label table is two entries longer than the dictionary.** `CTCLabelDecode`
// builds it as `['blank'] + character_dict + [' ']`: index 0 is the CTC blank, 1..N
// index the dictionary, and N+1 is a space (`use_space_char` is on). Those two extra
// slots are the whole reason this is code rather than a raw asset — getting the offset
// wrong does not error, it decodes to plausible-looking garbage.
//
// The v6 sizes do NOT share a dictionary: `medium` and `small` use the 50-language
// set, `tiny` a much smaller one. Pairing a model with the wrong table is the same
// silent-garbage failure, so model.ts pins one dictionary per model and checks the
// model's output width against its length before decoding anything.
import { fetchWeights } from '@bundled/yaar-ml';

export type CharsetId = 'v6' | 'v6-tiny';

/** One entry per distinct dictionary, not per model. */
const DICTIONARY_URLS: Record<CharsetId, string> = {
  v6: 'https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec_onnx/resolve/main/inference.yml',
  'v6-tiny':
    'https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx/resolve/main/inference.yml',
};

/**
 * Memoized per charset, and by URL again inside `fetchWeights`.
 *
 * The promise is cached rather than its result, so two recognitions starting at once
 * share one download instead of racing to store the same 114 KB twice.
 */
const loaded = new Map<CharsetId, Promise<string[]>>();

/**
 * Undo YAML single-quoted style (`'a'` → `a`, `''''` → `'`); plain scalars pass
 * through. The subset is hand-parsed deliberately: every entry is a lone scalar on its
 * own `  - x` line, so a YAML dependency would only buy cases that cannot occur.
 */
function unquote(scalar: string): string {
  if (scalar.length >= 2 && scalar.startsWith("'") && scalar.endsWith("'")) {
    return scalar.slice(1, -1).replaceAll("''", "'");
  }
  return scalar;
}

export function parseCharacterDict(yml: string): string[] {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'character_dict:');
  if (start < 0) throw new Error('no `character_dict:` key in the model config');

  const chars: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    // The list ends at the first line that is not one of its items.
    if (!line.startsWith('  - ')) break;
    const ch = unquote(line.slice(4));
    // Astral characters are in here (emoji, rare CJK ext-B), so count code points — a
    // `.length` check would reject every one of them as "two characters".
    if (Array.from(ch).length !== 1) {
      throw new Error(
        `dictionary entry ${chars.length} is not one character: ${JSON.stringify(ch)}`,
      );
    }
    chars.push(ch);
  }

  if (chars.length === 0) throw new Error('the model config parsed to an empty dictionary');
  return chars;
}

/** The dictionary for a charset, one array element per character. */
export function loadCharset(id: CharsetId): Promise<string[]> {
  const existing = loaded.get(id);
  if (existing) return existing;

  const pending = (async () => {
    const url = DICTIONARY_URLS[id];
    try {
      const buffer = await fetchWeights(url);
      return parseCharacterDict(new TextDecoder().decode(buffer));
    } catch (e) {
      // Cached in IndexedDB after the first success, so this can only bite on a first
      // run with no network — the same run whose weight download has already failed.
      throw new Error(
        `could not load the "${id}" character dictionary from ${url}: ${(e as Error).message}`,
      );
    }
  })();

  loaded.set(id, pending);
  pending.catch(() => loaded.delete(id)); // a failed fetch must not poison the cache
  return pending;
}
