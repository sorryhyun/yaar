export const uuid = () =>
  globalThis.crypto && 'randomUUID' in globalThis.crypto
    ? globalThis.crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function formatDistanceToNow(ts: number, opts?: { addSuffix?: boolean }) {
  const delta = Date.now() - ts;
  const sec = Math.max(1, Math.floor(Math.abs(delta) / 1000));
  const units: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [30, 'day'],
    [12, 'month'],
    [Infinity, 'year'],
  ];
  let n = sec;
  let label = 'second';
  for (const [base, name] of units) {
    label = name;
    if (n < base) break;
    n = Math.floor(n / base);
  }
  const txt = `${n} ${label}${n === 1 ? '' : 's'}`;
  if (!opts?.addSuffix) return txt;
  return delta >= 0 ? `${txt} ago` : `in ${txt}`;
}

export function debounce<T extends (...args: never[]) => void>(fn: T, wait = 300) {
  let t: number | null = null;
  return (...args: Parameters<T>) => {
    if (t) window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), wait);
  };
}
