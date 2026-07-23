/**
 * Unit tests for the multi-recognizer arbitration.
 *
 *   bun test apps/ocr/scripts/arbitrate.test.ts
 *
 * Outside `src/` for the same reason as geometry.test.ts: `apps/tsconfig.json` typechecks
 * `*​/src/**` with `types: []`, so a file importing `bun:test` from there would fail the
 * app typecheck.
 *
 * This layer is worth testing for the same reason the geometry is — it fails silently.
 * Picking the wrong candidate does not throw; it returns a confident, well-formed,
 * completely different line of text. The cases below are the failure modes that motivated
 * the shape of `trust`, written as the numbers a recognizer actually produces: a model
 * that lacks a script emits nothing or one stray character, never an error.
 */
import { describe, expect, test } from 'bun:test';
import { MARGIN, pickBest, trust, type Judged } from '../src/arbitrate';

const v6 = (text: string, confidence: number): Judged => ({ modelId: 'medium', text, confidence });
const ko = (text: string, confidence: number): Judged => ({ modelId: 'korean', text, confidence });

describe('trust', () => {
  test('an empty decode is worth nothing, however the model felt about it', () => {
    expect(trust('', 0)).toBe(0);
    expect(trust('', 0.99)).toBe(0);
    expect(trust('   ', 0.99)).toBe(0);
  });

  test('shrinks short decodes and leaves long ones nearly alone', () => {
    expect(trust('x', 1)).toBeCloseTo(1 / 3, 6);
    expect(trust('0123456789', 1)).toBeCloseTo(10 / 12, 6);
    expect(trust('x'.repeat(40), 1)).toBeCloseTo(40 / 42, 6);
  });

  test('counts code points, so an astral character is one character', () => {
    // Two UTF-16 units, one character: a naive `.length` would score this as 0.5.
    expect(trust('\u{20000}', 1)).toBeCloseTo(1 / 3, 6);
  });

  test('is monotonic in confidence at a fixed length', () => {
    expect(trust('hello', 0.9)).toBeGreaterThan(trust('hello', 0.6));
  });
});

describe('pickBest', () => {
  test('with one candidate there is nothing to arbitrate', () => {
    expect(pickBest([v6('hello', 0.9)]).modelId).toBe('medium');
  });

  test('the Korean model wins the line the v6 dictionary has no labels for', () => {
    // The measured shape of this case: v6 returns nothing at all for Hangul.
    const best = pickBest([v6('', 0), ko('한국어 텍스트 인식 테스트', 0.95)]);
    expect(best.modelId).toBe('korean');
  });

  test('one stray high-confidence character does not beat a full read', () => {
    // The reason `trust` is not mean confidence: a dictionary-less model emits *little*
    // text, not unconfident text.
    const best = pickBest([v6('国', 0.99), ko('한국어 텍스트 인식', 0.88)]);
    expect(best.modelId).toBe('korean');
  });

  test('a long low-confidence guess does not beat a short confident read', () => {
    // The reason `trust` is not summed confidence, which this case would invert.
    const best = pickBest([v6('OK', 0.98), ko('ㅇㅋㅇㅋㅇㅋㅇㅋㅇㅋ', 0.31)]);
    expect(best.modelId).toBe('medium');
  });

  test('the Chinese line stays with the model that has the ideographs', () => {
    const best = pickBest([v6('简体中文识别测试', 0.97), ko('간체중문', 0.42)]);
    expect(best.modelId).toBe('medium');
  });

  test('a tie on a line both models read goes to the primary', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    expect(pickBest([v6(text, 0.96), ko(text, 0.96)]).modelId).toBe('medium');
    // ...and stays there while the challenger leads by less than the margin, which is
    // what stops the same page reading differently from one run to the next.
    expect(pickBest([v6(text, 0.9), ko(text, 0.93)]).modelId).toBe('medium');
  });

  test('the challenger takes the line once it leads by more than the margin', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const long = text.length / (text.length + 2); // the shrink factor at this length
    const lead = (MARGIN + 0.02) / long;
    expect(pickBest([v6(text, 0.8), ko(text, 0.8 + lead)]).modelId).toBe('korean');
  });

  test('all-empty is still a decision, and it is the primary', () => {
    // Every model failed, so the caller reports `readable: false` — but the line still
    // needs a modelId, and attributing it to the primary is the honest default.
    expect(pickBest([v6('', 0), ko('', 0)]).modelId).toBe('medium');
  });

  test('arbitrates across more than two candidates', () => {
    const best = pickBest([
      v6('', 0),
      { modelId: 'tiny', text: '国', confidence: 0.9 },
      ko('한국어 텍스트', 0.93),
    ]);
    expect(best.modelId).toBe('korean');
  });
});
