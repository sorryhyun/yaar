import type { Rect } from './types';

export function colLabel(n: number): string {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

export function colNumber(label: string): number {
  let c = 0;
  for (const ch of label) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c;
}

export function key(c: number, r: number): string {
  return `${colLabel(c)}${r}`;
}

export function parseRef(ref: string): { c: number; r: number } | null {
  const m = ref.toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  return { c: colNumber(m[1]), r: Number(m[2]) };
}

export function rangeRect(a: string, b: string): Rect {
  const p1 = parseRef(a)!;
  const p2 = parseRef(b)!;
  return {
    c1: Math.min(p1.c, p2.c),
    c2: Math.max(p1.c, p2.c),
    r1: Math.min(p1.r, p2.r),
    r2: Math.max(p1.r, p2.r)
  };
}

export function refsInRect(rect: Rect): string[] {
  const out: string[] = [];
  for (let r = rect.r1; r <= rect.r2; r++) {
    for (let c = rect.c1; c <= rect.c2; c++) out.push(key(c, r));
  }
  return out;
}

export function expandRange(a: string, b: string): string[] {
  const p1 = parseRef(a);
  const p2 = parseRef(b);
  if (!p1 || !p2) return [];
  const out: string[] = [];
  const c1 = Math.min(p1.c, p2.c);
  const c2 = Math.max(p1.c, p2.c);
  const r1 = Math.min(p1.r, p2.r);
  const r2 = Math.max(p1.r, p2.r);
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) out.push(key(c, r));
  }
  return out;
}
