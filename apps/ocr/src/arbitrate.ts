// Choosing between two decodes of the same line. Pure — no DOM, no model, no fetch,
// which is what lets scripts/arbitrate.test.ts pin the judgement calls in it.
//
// The problem this solves is stated in ensemble.ts: no PaddleOCR recognizer covers every
// script, and **a recognizer cannot say "that is not my script."** With no labels for
// what it is looking at it emits blanks, or a stray character at high confidence — never
// an error. So there is nothing to ask, and nothing to route on before the fact. The only
// evidence is the two decodes themselves.

export interface Judged {
  modelId: string;
  text: string;
  confidence: number;
}

/**
 * How much a decode is worth, for the purpose of comparing it against another.
 *
 * Mean confidence alone cannot do this job: a model that lacks the script emits *little*
 * text, not unconfident text, so one stray character at 0.99 would beat a correct
 * ten-character read at 0.90. Total confidence — the sum over characters — inverts the
 * problem, letting a long, confident-looking hallucination beat a correct short read.
 *
 * So: confidence, shrunk toward zero for decodes too short to carry evidence.
 * `n / (n + SHRINK)` is 0.33 at one character, 0.83 at ten, and approaches 1 from there,
 * which is the shape wanted — discount one or two characters heavily, then stop caring
 * about length once there is enough of it to compare confidences honestly.
 *
 * An empty decode scores 0, which is how "this model cannot read this script" arrives.
 */
export const SHRINK = 2;

export function trust(text: string, confidence: number): number {
  // Code points, not UTF-16 units: the v6 dictionary contains astral characters, and
  // counting one double would flatter the decode that happened to include it.
  const n = [...text.trim()].length;
  if (n === 0) return 0;
  return confidence * (n / (n + SHRINK));
}

/**
 * How far ahead a later candidate must be to displace an earlier one.
 *
 * Candidates arrive primary-first, and the primary is the general model. On a line both
 * models can read, their decodes agree and their scores land within noise of each other;
 * whichever won a coin flip would make the same page read differently from one run to the
 * next, and would swap in the weaker mobile model's spelling half the time. The margin
 * leaves those with the primary, and leaves the specialist the case it exists for — where
 * the gap is not 0.02 but 0.8.
 */
export const MARGIN = 0.05;

/** The best of several decodes of one line. Candidates are primary-first. */
export function pickBest<T extends Judged>(candidates: T[]): T {
  let best = candidates[0];
  let bestTrust = trust(best.text, best.confidence);
  for (const candidate of candidates.slice(1)) {
    const score = trust(candidate.text, candidate.confidence);
    if (score > bestTrust + MARGIN) {
      best = candidate;
      bestTrust = score;
    }
  }
  return best;
}
