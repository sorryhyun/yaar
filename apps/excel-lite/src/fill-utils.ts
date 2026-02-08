import { key as cellKey, parseRef } from './ref-utils';
import type { Rect } from './types';

export function computeFillDestination(source: Rect, targetRef: string): Rect | null {
  const t = parseRef(targetRef);
  if (!t) return null;

  const up = t.r < source.r1;
  const down = t.r > source.r2;
  const left = t.c < source.c1;
  const right = t.c > source.c2;
  if (!up && !down && !left && !right) return null;

  const rowDist = up ? (source.r1 - t.r) : (down ? (t.r - source.r2) : 0);
  const colDist = left ? (source.c1 - t.c) : (right ? (t.c - source.c2) : 0);

  if ((up || down) && rowDist >= colDist) {
    return up
      ? { c1: source.c1, c2: source.c2, r1: t.r, r2: source.r1 - 1 }
      : { c1: source.c1, c2: source.c2, r1: source.r2 + 1, r2: t.r };
  }

  return left
    ? { c1: t.c, c2: source.c1 - 1, r1: source.r1, r2: source.r2 }
    : { c1: source.c2 + 1, c2: t.c, r1: source.r1, r2: source.r2 };
}

export function sourceForDestination(source: Rect, destRef: string): string {
  const p = parseRef(destRef)!;
  const h = source.r2 - source.r1 + 1;
  const w = source.c2 - source.c1 + 1;

  let sr = source.r1;
  let sc = source.c1;

  if (p.r > source.r2) sr = source.r1 + ((p.r - source.r1) % h);
  else if (p.r < source.r1) sr = source.r2 - ((source.r1 - p.r - 1) % h);
  else sr = p.r;

  if (p.c > source.c2) sc = source.c1 + ((p.c - source.c1) % w);
  else if (p.c < source.c1) sc = source.c2 - ((source.c1 - p.c - 1) % w);
  else sc = p.c;

  return cellKey(sc, sr);
}
