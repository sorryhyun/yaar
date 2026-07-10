// Pure-JS reimplementations of the two HF tokenizers Anima's text path needs.
// No npm tokenizer runtime — we read the same `tokenizer.json` files the Python
// pipeline uses and reproduce their algorithms exactly.
//
//   tokenizer/     Qwen3  — byte-level BPE   (NFC → Split regex → ByteLevel → BPE)
//   t5_tokenizer/  T5     — Unigram          (NFKC → WhitespaceSplit → Metaspace → Viterbi)
//
// Both are verified byte-for-byte against ids produced by `tokenizers` in Python
// (see webgpu/qwen_ids.json, webgpu/t5_ids.json and the golden prompt).
import { fetchJSON } from './ml';

export const SEQ = 512; // both graphs are exported at a fixed L=512
const QWEN_PAD = 151643; // <|endoftext|>
const T5_PAD = 0; // <pad>
const T5_EOS = 1; // </s>

// ─────────────────────────── Qwen3: byte-level BPE ───────────────────────────
/** GPT-2's bytes→printable-unicode alphabet, so every byte has a vocab symbol. */
function bytesToUnicode(): string[] {
  const bs: number[] = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  }
  const out: string[] = new Array(256);
  for (let i = 0; i < bs.length; i++) out[bs[i]] = String.fromCodePoint(cs[i]);
  return out;
}

// The pre_tokenizer's Split regex, with `(?i:…)` expanded — inline modifier
// groups are ES2025 and not universally available yet.
const QWEN_RE =
  /'(?:[sS]|[tT]|[rR][eE]|[vV][eE]|[mM]|[lL][lL]|[dD])|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

export class QwenBPE {
  private vocab: Record<string, number>;
  private ranks = new Map<string, number>();
  private b2u = bytesToUnicode();
  private enc = new TextEncoder();

  constructor(tj: {
    model: { vocab: Record<string, number>; merges: (string | [string, string])[] };
  }) {
    this.vocab = tj.model.vocab;
    tj.model.merges.forEach((m, i) => {
      const [a, b] = Array.isArray(m) ? m : (m.split(' ') as [string, string]);
      this.ranks.set(a + ' ' + b, i);
    });
  }

  /** Greedily apply the lowest-rank merge until none applies. */
  private bpe(token: string): string[] {
    let parts = Array.from(token);
    while (parts.length > 1) {
      let best = Infinity;
      let bi = -1;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = this.ranks.get(parts[i] + ' ' + parts[i + 1]);
        if (r !== undefined && r < best) {
          best = r;
          bi = i;
        }
      }
      if (bi < 0) break;
      parts.splice(bi, 2, parts[bi] + parts[bi + 1]);
    }
    return parts;
  }

  encode(text: string): number[] {
    const ids: number[] = [];
    for (const m of text.normalize('NFC').matchAll(QWEN_RE)) {
      let s = '';
      for (const b of this.enc.encode(m[0])) s += this.b2u[b];
      // `ignore_merges: true` — a pretoken that is itself a vocab entry is emitted
      // verbatim, before any merge is considered.
      const direct = this.vocab[s];
      if (direct !== undefined) {
        ids.push(direct);
        continue;
      }
      for (const piece of this.bpe(s)) {
        const id = this.vocab[piece];
        if (id === undefined) throw new Error(`qwen: no vocab entry for ${JSON.stringify(piece)}`);
        ids.push(id);
      }
    }
    return ids;
  }
}

// ───────────────────────────── T5: Unigram (Viterbi) ─────────────────────────
/** Mirrors HF `tokenizers` Unigram::encode, including the two subtleties that
 *  a naive Viterbi gets wrong: `<unk>` nodes are only inserted where no
 *  length-1 piece exists (scored `minScore - 10`), and consecutive `<unk>`s are
 *  fused into one. The DP runs over code points so surrogate pairs stay atomic. */
export class T5Unigram {
  private pieces = new Map<string, { id: number; score: number }>();
  private unkId: number;
  private unkScore: number;
  private maxLen = 0; // longest piece, in code points

  constructor(tj: { model: { unk_id: number; vocab: [string, number][] } }) {
    this.unkId = tj.model.unk_id;
    let min = Infinity;
    tj.model.vocab.forEach(([piece, score], i) => {
      this.pieces.set(piece, { id: i, score });
      this.maxLen = Math.max(this.maxLen, Array.from(piece).length);
      if (score < min) min = score;
    });
    this.unkScore = min - 10.0; // sentencepiece's K_UNK_PENALTY
  }

  private viterbi(word: string): number[] {
    const cp = Array.from(word);
    const n = cp.length;
    const best = new Float64Array(n + 1).fill(-Infinity);
    const back = new Int32Array(n + 1).fill(-1);
    const backId = new Int32Array(n + 1).fill(-1);
    best[0] = 0;
    for (let i = 0; i < n; i++) {
      if (best[i] === -Infinity) continue;
      let hasSingle = false;
      for (let l = 1; l <= Math.min(this.maxLen, n - i); l++) {
        const p = this.pieces.get(cp.slice(i, i + l).join(''));
        if (!p) continue;
        if (l === 1) hasSingle = true;
        const sc = best[i] + p.score;
        if (sc > best[i + l]) {
          best[i + l] = sc;
          back[i + l] = i;
          backId[i + l] = p.id;
        }
      }
      if (!hasSingle) {
        const sc = best[i] + this.unkScore;
        if (sc > best[i + 1]) {
          best[i + 1] = sc;
          back[i + 1] = i;
          backId[i + 1] = this.unkId;
        }
      }
    }
    const out: number[] = [];
    for (let i = n; i > 0; i = back[i]) out.push(backId[i]);
    out.reverse();
    return out.filter((id, k) => !(id === this.unkId && out[k - 1] === this.unkId));
  }

  encode(text: string): number[] {
    // The real normalizer is a Precompiled charsmap (sentencepiece `nmt_nfkc`).
    // NFKC reproduces it for every character we've tested (latin-1, CJK, emoji,
    // ligatures, fractions); exotic control-char folds may differ.
    const ids: number[] = [];
    for (const word of text.normalize('NFKC').split(/\s+/).filter(Boolean)) {
      ids.push(...this.viterbi('▁' + word)); // Metaspace, prepend_scheme=always
    }
    ids.push(T5_EOS);
    return ids;
  }
}

// ───────────────────────────────── padding ───────────────────────────────────
export interface Encoded {
  ids: BigInt64Array;
  mask: BigInt64Array;
  /** number of real (unpadded) tokens */
  length: number;
}

function padTo(ids: number[], padId: number): Encoded {
  const out = new BigInt64Array(SEQ).fill(BigInt(padId));
  const mask = new BigInt64Array(SEQ);
  const n = Math.min(ids.length, SEQ);
  for (let i = 0; i < n; i++) {
    out[i] = BigInt(ids[i]);
    mask[i] = 1n;
  }
  return { ids: out, mask, length: n };
}

// ───────────────────────────────── loading ───────────────────────────────────
export interface Tokenizers {
  qwen: QwenBPE;
  t5: T5Unigram;
}

let _toks: Promise<Tokenizers> | undefined;
/** Fetch + parse both `tokenizer.json` files (11.4 MB + 2.4 MB, IDB-cached). */
export function loadTokenizers(): Promise<Tokenizers> {
  _toks ??= (async () => {
    const [q, t] = await Promise.all([
      fetchJSON('webgpu/tokenizer/tokenizer.json'),
      fetchJSON('webgpu/t5_tokenizer/tokenizer.json'),
    ]);
    return { qwen: new QwenBPE(q), t5: new T5Unigram(t) };
  })();
  return _toks;
}

export interface PromptTokens {
  qwen: Encoded;
  t5: Encoded;
}

/** Tokenize one prompt for both graphs, right-padded/truncated to L=512. */
export function tokenizePrompt(toks: Tokenizers, prompt: string): PromptTokens {
  const q = toks.qwen.encode(prompt);
  let t = toks.t5.encode(prompt);
  // truncation=True reserves the last slot for </s>, matching HF's post-processor
  if (t.length > SEQ) t = [...t.slice(0, SEQ - 1), T5_EOS];
  return { qwen: padTo(q, QWEN_PAD), t5: padTo(t, T5_PAD) };
}
